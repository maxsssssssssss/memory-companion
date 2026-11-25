import { afterEach, describe, expect, it } from "vitest";
import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository } from "./repository";

describe("recording-local roles in generated review prose", () => {
  let db: ReturnType<typeof openDateCompanionDatabase>;
  afterEach(() => db.close());
  const uploadId = "92fa5a97-500b-4bc6-811f-4ac9495de080";
  const raw = "speaker_1 答应下周一晚饭前寄出纸样，前提是先确认地址。";
  const speaker = "candidate_chunk_00000_unknown_74e62f13620d22eb";
  const id = uploadId + "_chunk_00000_seg_00002";
  function draft(proposed = raw, speakerId = speaker, quote = "我答应寄出纸样，前提是先确认地址。", kind: "promise" | "moment" = "promise") {
    db = openDateCompanionDatabase({ filePath: ":memory:" });
    const repo = new DateCompanionRepository(db);
    const relation = repo.createOrGetRelationship("u", "独立样本").relationship.id;
    const { interactionId } = repo.importInteraction({
      userId: "u", relationshipId: relation, sourceUploadId: uploadId, recordingDate: "2026-11-20", originalName: "s03i.wav",
      participants: [{ speakerId }], recapCandidates: [{ kind, proposedText: proposed, sortOrder: 0,
        evidence: [{ uploadId, sourceSegmentId: id, startSeconds: 13.24, endSeconds: 25.57, speakerId, quote }] }]
    });
    const get = () => repo.getInteractionDetail("u", relation, interactionId);
    const item = get().recapItems[0];
    function save(role: "self" | "companion", edited?: string) {
      repo.updateRecap({ userId: "u", interactionId, version: get().version, finalize: true, skipMemoryAdmission: true,
        assignments: [{ speakerId, role }], mutations: [{ id: item.id, version: item.version, disposition: "kept", userText: edited }] });
      return get().recapItems[0];
    }
    return { repo, relation, get, item, save, interactionId };
  }
  it("projects the S03I chunk hash only after confirmation, including legacy promise rows and search", () => {
    const { repo, relation, item, save } = draft();
    expect(item.displayedText).toBe(raw.replace("speaker_1 ", "说话人"));
    const saved = save("self");
    const displayed = raw.replace("speaker_1 ", "我");
    expect(saved.displayedText).toBe(displayed);
    expect(saved.proposedText).toBe(raw);
    expect(saved.evidence).toEqual(item.evidence);
    expect(db.prepare("SELECT text FROM dc_promises").get()).toEqual({ text: raw });
    expect(repo.getRelationshipView("u", relation).promises[0].text).toBe(displayed);
    expect(repo.search("u", relation, "纸样")[0].text).toBe(displayed);
    expect(db.prepare("SELECT text FROM dc_promises").get()).toEqual({ text: raw });
    const savedQuote = saved.evidence[0].quote;
    db.prepare("UPDATE dc_promises SET text=?").run(savedQuote);
    expect(repo.getRelationshipView("u", relation).promises[0].text).toBe(savedQuote);
  });
  it("leaves even user-edited speaker labels intact", () => {
    const { save, repo, relation } = draft();
    const edited = "speaker_1 是我写的编号。";
    expect(save("self", edited).displayedText).toBe(edited);
    expect(repo.getRelationshipView("u", relation).promises[0].text).toBe(edited);
  });
  it("protects the quoted text and requires the actual label for a named role", () => {
    const { save } = draft("speaker_1 提到「speaker_1 表示编号」，speaker_2 转述。", speaker, "原句中的 speaker_1 保留。", "moment");
    const result = save("companion");
    expect(result.displayedText).toBe("Ta提到「speaker_1 表示编号」，说话人转述。");
    expect(result.evidence[0].quote).toBe("原句中的 speaker_1 保留。");
  });
  it("preserves verbatim source-copy proposals even without quotation marks", () => {
    const { save } = draft(raw, speaker, raw);
    expect(save("self").displayedText).toBe(raw);
  });
  it("does not use the recording role to fill an unreviewed mixed-speaker segment", () => {
    const { get, interactionId, repo } = draft(raw, "speaker_1", undefined, "moment");
    repo.updateParticipants({ userId: "u", interactionId, version: get().version,
      assignments: [{speakerId:"speaker_1", role:"unresolved", reviewedSegments:[]}] });
    expect(get().recapItems[0].displayedText).toBe(raw.replace("speaker_1 ", "说话人"));
  });
  it("does not name the author when the same snapshot no longer matches its digest", () => {
    const { get, save } = draft();
    save("self");
    db.prepare("UPDATE dc_evidence_snapshots SET quote='另一版原句'").run();
    expect(get().recapItems[0].displayedText).toBe(raw.replace("speaker_1 ", "说话人"));
  });
});
