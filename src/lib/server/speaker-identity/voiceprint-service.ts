import { createHash } from "node:crypto";

import { isChunkLocalSpeakerLabel } from "@/lib/domain/speaker-identity";
import {
  JsonSpeakerIdentityRepository,
  type ManualSpeakerIdentityMapping,
  type SpeakerIdentityRepository,
  type SpeakerIdentityProfile
} from "./repository";
import {
  createConfiguredVoiceprintProvider,
  VOICEPRINT_PROVIDER_KNOWN_USER_LABEL,
  VoiceprintProviderError,
  type VoiceprintProvider,
  type VoiceprintTrainingAudio
} from "./voiceprint-client";
import {
  JsonVoiceprintOperationRepository,
  type VoiceprintOperation,
  type VoiceprintOperationRepository
} from "./voiceprint-operation-repository";
import type { VoiceIdentityProfile } from "./types";
import type { JsonStore } from "@/lib/server/storage/json-store";

const MAX_CONTACT_PROFILES = 10;
const workflowLocks = new Map<string, Promise<unknown>>();

type ProfileRepository = Pick<
  SpeakerIdentityRepository,
  "saveProfile" | "getProfile" | "listProfiles" | "saveManualMapping" | "getManualMapping"
>;

export type TrainUserVoiceprintInput = {
  userId: string;
  requestId: string;
  audio: VoiceprintTrainingAudio[];
  displayName?: string;
};

export type SaveContactVoiceprintInput = {
  userId: string;
  requestId: string;
  recordId: string;
  uploadId: string;
  chunkId: string;
  localSpeaker: string;
  globalSpeakerId: string;
  displayName: string;
  providerSpeakerId: string;
};

export type TrainUserVoiceprintResult = {
  operation: VoiceprintOperation;
  profile: SpeakerIdentityProfile & VoiceIdentityProfile;
  reused: boolean;
};

export type SaveContactVoiceprintResult = {
  operation: VoiceprintOperation;
  profile: SpeakerIdentityProfile & VoiceIdentityProfile;
  mapping: ManualSpeakerIdentityMapping;
  reused: boolean;
};

export class VoiceprintWorkflowError extends Error {
  constructor(
    readonly reason:
      | "request_id_conflict"
      | "operation_in_progress"
      | "contact_limit_reached"
      | "identity_type_conflict"
      | "invalid_contact_name"
      | "persistence_error",
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "VoiceprintWorkflowError";
  }
}

function knownUserGlobalSpeakerId(userId: string) {
  return `user_${userId.trim()}`;
}

function providerSpeakerLabel(profile: SpeakerIdentityProfile) {
  return profile.providerReference?.speakerLabel ?? profile.voiceprintSpeakerId;
}

function matchesKnownUserProviderLabel(
  profile: SpeakerIdentityProfile,
  userId: string
) {
  const speakerLabel = providerSpeakerLabel(profile);
  return (
    speakerLabel === VOICEPRINT_PROVIDER_KNOWN_USER_LABEL ||
    (
      profile.identityType === "known_user" &&
      profile.providerReference?.operationType === "train" &&
      speakerLabel === userId
    )
  );
}

function completeVoiceIdentityProfile(
  profile: SpeakerIdentityProfile
): profile is SpeakerIdentityProfile & VoiceIdentityProfile {
  return Boolean(
    profile.userId &&
    profile.providerReference &&
    profile.identityType !== "unknown_person" &&
    (profile.identityType !== "known_contact" || profile.contactName)
  );
}

function requireCompleteVoiceIdentityProfile(
  profile: SpeakerIdentityProfile
): SpeakerIdentityProfile & VoiceIdentityProfile {
  if (!completeVoiceIdentityProfile(profile)) {
    throw new VoiceprintWorkflowError(
      "persistence_error",
      "voice identity profile is incomplete"
    );
  }
  return profile;
}

function inputDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function trainInputDigest(input: TrainUserVoiceprintInput) {
  return inputDigest({
    operationType: "train",
    userId: input.userId.trim(),
    audio: input.audio.map((item) => ({
      url: item.url,
      rule: item.rule
    }))
  });
}

function saveInputDigest(input: SaveContactVoiceprintInput) {
  return inputDigest({
    operationType: "save",
    userId: input.userId.trim(),
    recordId: input.recordId.trim(),
    uploadId: input.uploadId.trim(),
    chunkId: input.chunkId.trim(),
    localSpeaker: input.localSpeaker.trim(),
    globalSpeakerId: input.globalSpeakerId.trim(),
    displayName: input.displayName.trim(),
    providerSpeakerId: input.providerSpeakerId.trim()
  });
}

async function withWorkflowLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = workflowLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  workflowLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (workflowLocks.get(key) === current) {
      workflowLocks.delete(key);
    }
  }
}

function providerFailureMetadata(
  error: unknown,
  subjectType: "known_user" | "known_contact",
  digest: string,
  extra: { audioCount?: number; incremental?: boolean; globalSpeakerId?: string } = {}
): VoiceprintOperation["resultMetadata"] {
  if (error instanceof VoiceprintProviderError) {
    return {
      inputDigest: digest,
      subjectType,
      providerSucceeded: false,
      providerAttemptCount: error.attemptCount,
      failureReason: error.reason,
      failurePhase: "provider",
      retryable: error.retryable,
      ...(error.status ? { httpStatus: error.status } : {}),
      ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
      ...extra
    };
  }
  return {
    inputDigest: digest,
    subjectType,
    providerSucceeded: false,
    failureReason: "network_error",
    failurePhase: "provider",
    retryable: false,
    ...extra
  };
}

export class VoiceprintService {
  constructor(
    private readonly provider: VoiceprintProvider,
    private readonly profiles: ProfileRepository,
    private readonly operations: VoiceprintOperationRepository
  ) {}

  private async saveKnownUserProfile(
    input: TrainUserVoiceprintInput
  ): Promise<SpeakerIdentityProfile & VoiceIdentityProfile> {
    const profile = await this.profiles.saveProfile({
      globalSpeakerId: knownUserGlobalSpeakerId(input.userId),
      userId: input.userId,
      ...(input.displayName?.trim()
        ? { displayName: input.displayName.trim() }
        : {}),
      identityType: "known_user",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: VOICEPRINT_PROVIDER_KNOWN_USER_LABEL,
        lastRequestId: input.requestId,
        operationType: "train"
      },
      voiceprintSpeakerId: VOICEPRINT_PROVIDER_KNOWN_USER_LABEL
    });
    return requireCompleteVoiceIdentityProfile(profile);
  }

  private async saveKnownContactProfile(
    input: SaveContactVoiceprintInput
  ): Promise<SpeakerIdentityProfile & VoiceIdentityProfile> {
    const profile = await this.profiles.saveProfile({
      globalSpeakerId: input.globalSpeakerId,
      userId: input.userId,
      contactName: input.displayName,
      displayName: input.displayName,
      identityType: "known_contact",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: input.providerSpeakerId,
        lastRequestId: input.requestId,
        operationType: "save"
      },
      voiceprintSpeakerId: input.providerSpeakerId
    });
    return requireCompleteVoiceIdentityProfile(profile);
  }

  private async existingOperation(
    requestId: string,
    operationType: VoiceprintOperation["operationType"],
    digest: string
  ) {
    const existing = await this.operations.get(requestId);
    if (existing && existing.operationType !== operationType) {
      throw new VoiceprintWorkflowError(
        "request_id_conflict",
        "voiceprint request id is already used by another operation"
      );
    }
    if (existing && existing.resultMetadata.inputDigest !== digest) {
      throw new VoiceprintWorkflowError(
        "request_id_conflict",
        "voiceprint request id is already used by different input"
      );
    }
    return existing;
  }

  private async recordProviderFailure(input: {
    requestId: string;
    operationType: VoiceprintOperation["operationType"];
    metadata: VoiceprintOperation["resultMetadata"];
  }) {
    try {
      await this.operations.save({
        providerRequestId: input.requestId,
        operationType: input.operationType,
        status: "failed",
        resultMetadata: input.metadata
      });
    } catch {
      // The original provider failure is more actionable. A repository outage
      // must not replace it or expose request payload details.
    }
  }

  async trainUser(input: TrainUserVoiceprintInput): Promise<TrainUserVoiceprintResult> {
    return await withWorkflowLock(
      input.requestId,
      async () => await this.trainUserLocked(input)
    );
  }

  private async trainUserLocked(
    input: TrainUserVoiceprintInput
  ): Promise<TrainUserVoiceprintResult> {
    const digest = trainInputDigest(input);
    const globalSpeakerId = knownUserGlobalSpeakerId(input.userId);
    const existingOperation = await this.existingOperation(
      input.requestId,
      "train",
      digest
    );
    if (existingOperation?.status === "succeeded") {
      let profile = await this.profiles.getProfile(globalSpeakerId);
      if (!profile || profile.identityType !== "known_user") {
        throw new VoiceprintWorkflowError(
          "persistence_error",
          "completed voiceprint training is missing its local profile"
        );
      }
      const completedProfile =
        completeVoiceIdentityProfile(profile) &&
        profile.providerReference.speakerLabel === VOICEPRINT_PROVIDER_KNOWN_USER_LABEL
        ? profile
        : await this.saveKnownUserProfile(input);
      return { operation: existingOperation, profile: completedProfile, reused: true };
    }
    if (existingOperation?.status === "pending") {
      const profile = await this.profiles.getProfile(globalSpeakerId);
      if (
        profile &&
        completeVoiceIdentityProfile(profile) &&
        profile.identityType === "known_user" &&
        profile.userId === input.userId &&
        profile.providerReference.operationType === "train" &&
        profile.providerReference.lastRequestId === input.requestId &&
        matchesKnownUserProviderLabel(profile, input.userId)
      ) {
        const completedProfile =
          profile.providerReference.speakerLabel === VOICEPRINT_PROVIDER_KNOWN_USER_LABEL
            ? profile
            : await this.saveKnownUserProfile(input);
        const operation = await this.operations.save({
          providerRequestId: input.requestId,
          operationType: "train",
          status: "succeeded",
          resultMetadata: {
            inputDigest: digest,
            subjectType: "known_user",
            providerCode: 0,
            providerSucceeded: true,
            audioCount: input.audio.length,
            incremental: input.audio.length > 1,
            globalSpeakerId
          }
        });
        return { operation, profile: completedProfile, reused: true };
      }
      throw new VoiceprintWorkflowError(
        "operation_in_progress",
        "voiceprint operation is already in progress"
      );
    }

    const existingProfile = await this.profiles.getProfile(globalSpeakerId);
    if (existingProfile && existingProfile.identityType !== "known_user") {
      throw new VoiceprintWorkflowError(
        "identity_type_conflict",
        "voiceprint user profile conflicts with an existing identity"
      );
    }
    const conflictingProviderIdentity = (await this.profiles.listProfiles()).find(
      (profile) =>
        profile.globalSpeakerId !== globalSpeakerId &&
        (
          providerSpeakerLabel(profile) === VOICEPRINT_PROVIDER_KNOWN_USER_LABEL ||
          matchesKnownUserProviderLabel(profile, input.userId)
        )
    );
    if (conflictingProviderIdentity) {
      throw new VoiceprintWorkflowError(
        "identity_type_conflict",
        "voiceprint provider identity is already assigned to another profile"
      );
    }

    let providerResult = existingOperation?.status === "provider_succeeded"
      ? {
          code: 0 as const,
          attemptCount:
            existingOperation.resultMetadata.providerAttemptCount ?? 1,
          ...(existingOperation.resultMetadata.providerMessagePresent
            ? { message: "recorded" }
            : {})
        }
      : undefined;
    if (!providerResult) {
      await this.operations.save({
        providerRequestId: input.requestId,
        operationType: "train",
        status: "pending",
        resultMetadata: {
          inputDigest: digest,
          subjectType: "known_user",
          providerSucceeded: false,
          audioCount: input.audio.length,
          incremental: input.audio.length > 1,
          globalSpeakerId
        }
      });
      try {
        providerResult = await this.provider.train({
          userId: input.userId,
          requestId: input.requestId,
          audio: input.audio
        });
        await this.operations.save({
          providerRequestId: input.requestId,
          operationType: "train",
          status: "provider_succeeded",
          resultMetadata: {
            inputDigest: digest,
            subjectType: "known_user",
            providerCode: providerResult.code,
            providerMessagePresent: Boolean(providerResult.message),
            providerAttemptCount: providerResult.attemptCount,
            providerSucceeded: true,
            audioCount: input.audio.length,
            incremental: input.audio.length > 1,
            globalSpeakerId
          }
        });
      } catch (error) {
        if (providerResult) {
          console.warn(
            `[voiceprint] provider_succeeded_checkpoint_failed operation=train error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        } else {
          await this.recordProviderFailure({
            requestId: input.requestId,
            operationType: "train",
            metadata: providerFailureMetadata(error, "known_user", digest, {
              audioCount: input.audio.length,
              incremental: input.audio.length > 1,
              globalSpeakerId
            })
          });
          throw error;
        }
      }
    }
    if (!providerResult) {
      throw new VoiceprintWorkflowError(
        "persistence_error",
        "voiceprint training did not produce a Provider result"
      );
    }

    try {
      const profile = await this.saveKnownUserProfile(input);
      const operation = await this.operations.save({
        providerRequestId: input.requestId,
        operationType: "train",
        status: "succeeded",
        resultMetadata: {
          inputDigest: digest,
          subjectType: "known_user",
          providerCode: providerResult.code,
          providerMessagePresent: Boolean(providerResult.message),
          providerAttemptCount: providerResult.attemptCount,
          providerSucceeded: true,
          audioCount: input.audio.length,
          incremental: input.audio.length > 1,
          globalSpeakerId
        }
      });
      return { operation, profile, reused: false };
    } catch (error) {
      await this.operations.save({
        providerRequestId: input.requestId,
        operationType: "train",
        status: "provider_succeeded",
        resultMetadata: {
          inputDigest: digest,
          subjectType: "known_user",
          providerCode: providerResult.code,
          providerMessagePresent: Boolean(providerResult.message),
          providerAttemptCount: providerResult.attemptCount,
          providerSucceeded: true,
          audioCount: input.audio.length,
          incremental: input.audio.length > 1,
          globalSpeakerId,
          failureReason: "persistence_error",
          failurePhase: "persistence",
          retryable: false
        }
      }).catch(() => undefined);
      throw new VoiceprintWorkflowError(
        "persistence_error",
        "voiceprint training succeeded but local metadata persistence failed",
        error
      );
    }
  }

  async saveContact(
    input: SaveContactVoiceprintInput
  ): Promise<SaveContactVoiceprintResult> {
    return await withWorkflowLock(
      input.requestId,
      async () => await this.saveContactLocked(input)
    );
  }

  private async saveContactLocked(
    input: SaveContactVoiceprintInput
  ): Promise<SaveContactVoiceprintResult> {
    if (
      isChunkLocalSpeakerLabel(input.displayName) ||
      isChunkLocalSpeakerLabel(input.providerSpeakerId)
    ) {
      throw new VoiceprintWorkflowError(
        "invalid_contact_name",
        "a chunk-local speaker label cannot be used as a contact identity"
      );
    }

    const digest = saveInputDigest(input);
    const existingOperation = await this.existingOperation(
      input.requestId,
      "save",
      digest
    );
    if (existingOperation?.status === "succeeded") {
      let [profile, mapping] = await Promise.all([
        this.profiles.getProfile(input.globalSpeakerId),
        this.profiles.getManualMapping({
          uploadId: input.uploadId,
          chunkId: input.chunkId,
          localSpeaker: input.localSpeaker
        })
      ]);
      if (!profile || profile.identityType !== "known_contact" || !mapping) {
        throw new VoiceprintWorkflowError(
          "persistence_error",
          "completed voiceprint save is missing its local mapping"
        );
      }
      const completedProfile = completeVoiceIdentityProfile(profile)
        ? profile
        : await this.saveKnownContactProfile(input);
      return {
        operation: existingOperation,
        profile: completedProfile,
        mapping,
        reused: true
      };
    }
    if (existingOperation?.status === "pending") {
      const [profile, mapping] = await Promise.all([
        this.profiles.getProfile(input.globalSpeakerId),
        this.profiles.getManualMapping({
          uploadId: input.uploadId,
          chunkId: input.chunkId,
          localSpeaker: input.localSpeaker
        })
      ]);
      if (
        profile &&
        completeVoiceIdentityProfile(profile) &&
        profile.identityType === "known_contact" &&
        profile.userId === input.userId &&
        profile.contactName === input.displayName &&
        profile.providerReference.operationType === "save" &&
        profile.providerReference.lastRequestId === input.requestId &&
        profile.providerReference.speakerLabel === input.providerSpeakerId &&
        mapping?.globalSpeakerId === input.globalSpeakerId
      ) {
        const operation = await this.operations.save({
          providerRequestId: input.requestId,
          operationType: "save",
          status: "succeeded",
          resultMetadata: {
            inputDigest: digest,
            subjectType: "known_contact",
            providerCode: 0,
            providerSucceeded: true,
            globalSpeakerId: input.globalSpeakerId
          }
        });
        return { operation, profile, mapping, reused: true };
      }
      throw new VoiceprintWorkflowError(
        "operation_in_progress",
        "voiceprint operation is already in progress"
      );
    }

    const existingProfile = await this.profiles.getProfile(input.globalSpeakerId);
    if (existingProfile && existingProfile.identityType !== "known_contact") {
      throw new VoiceprintWorkflowError(
        "identity_type_conflict",
        "voiceprint contact conflicts with an existing identity"
      );
    }
    const profiles = await this.profiles.listProfiles();
    const conflictingProviderIdentity = profiles.find(
      (profile) =>
        profile.globalSpeakerId !== input.globalSpeakerId &&
        providerSpeakerLabel(profile) === input.providerSpeakerId
    );
    if (conflictingProviderIdentity) {
      throw new VoiceprintWorkflowError(
        "identity_type_conflict",
        "voiceprint provider identity is already assigned to another profile"
      );
    }
    if (!existingProfile) {
      const contacts = profiles.filter(
        (profile) => profile.identityType === "known_contact"
      );
      if (contacts.length >= MAX_CONTACT_PROFILES) {
        throw new VoiceprintWorkflowError(
          "contact_limit_reached",
          `voiceprint contact limit of ${MAX_CONTACT_PROFILES} has been reached`
        );
      }
    }

    let providerResult = existingOperation?.status === "provider_succeeded"
      ? {
          code: 0 as const,
          attemptCount:
            existingOperation.resultMetadata.providerAttemptCount ?? 1,
          ...(existingOperation.resultMetadata.providerMessagePresent
            ? { message: "recorded" }
            : {})
        }
      : undefined;
    if (!providerResult) {
      await this.operations.save({
        providerRequestId: input.requestId,
        operationType: "save",
        status: "pending",
        resultMetadata: {
          inputDigest: digest,
          subjectType: "known_contact",
          providerSucceeded: false,
          globalSpeakerId: input.globalSpeakerId
        }
      });
      try {
        providerResult = await this.provider.save({
          userId: input.userId,
          recordId: input.recordId,
          speakerId: input.localSpeaker,
          speakerName: input.providerSpeakerId,
          requestId: input.requestId
        });
        await this.operations.save({
          providerRequestId: input.requestId,
          operationType: "save",
          status: "provider_succeeded",
          resultMetadata: {
            inputDigest: digest,
            subjectType: "known_contact",
            providerCode: providerResult.code,
            providerMessagePresent: Boolean(providerResult.message),
            providerAttemptCount: providerResult.attemptCount,
            providerSucceeded: true,
            globalSpeakerId: input.globalSpeakerId
          }
        });
      } catch (error) {
        if (providerResult) {
          console.warn(
            `[voiceprint] provider_succeeded_checkpoint_failed operation=save error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        } else {
          await this.recordProviderFailure({
            requestId: input.requestId,
            operationType: "save",
            metadata: providerFailureMetadata(error, "known_contact", digest, {
              globalSpeakerId: input.globalSpeakerId
            })
          });
          throw error;
        }
      }
    }
    if (!providerResult) {
      throw new VoiceprintWorkflowError(
        "persistence_error",
        "voiceprint save did not produce a Provider result"
      );
    }

    try {
      const profile = await this.saveKnownContactProfile(input);
      const mapping = await this.profiles.saveManualMapping({
        uploadId: input.uploadId,
        chunkId: input.chunkId,
        localSpeaker: input.localSpeaker,
        globalSpeakerId: input.globalSpeakerId
      });
      const operation = await this.operations.save({
        providerRequestId: input.requestId,
        operationType: "save",
        status: "succeeded",
        resultMetadata: {
          inputDigest: digest,
          subjectType: "known_contact",
          providerCode: providerResult.code,
          providerMessagePresent: Boolean(providerResult.message),
          providerAttemptCount: providerResult.attemptCount,
          providerSucceeded: true,
          globalSpeakerId: input.globalSpeakerId
        }
      });
      return { operation, profile, mapping, reused: false };
    } catch (error) {
      await this.operations.save({
        providerRequestId: input.requestId,
        operationType: "save",
        status: "provider_succeeded",
        resultMetadata: {
          inputDigest: digest,
          subjectType: "known_contact",
          providerCode: providerResult.code,
          providerMessagePresent: Boolean(providerResult.message),
          providerAttemptCount: providerResult.attemptCount,
          providerSucceeded: true,
          globalSpeakerId: input.globalSpeakerId,
          failureReason: "persistence_error",
          failurePhase: "persistence",
          retryable: false
        }
      }).catch(() => undefined);
      throw new VoiceprintWorkflowError(
        "persistence_error",
        "voiceprint save succeeded but local mapping persistence failed",
        error
      );
    }
  }
}

export function createConfiguredVoiceprintService(store: JsonStore) {
  return new VoiceprintService(
    createConfiguredVoiceprintProvider(),
    new JsonSpeakerIdentityRepository(store),
    new JsonVoiceprintOperationRepository(store)
  );
}
