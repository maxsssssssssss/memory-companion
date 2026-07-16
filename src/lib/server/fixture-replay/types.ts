import { z } from "zod";

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SafeIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);

export const FixtureSessionSchema = z.object({
  datasetVersion: z.string().min(1),
  sessionId: SafeIdSchema,
  userId: SafeIdSchema,
  recordedAt: z.string().datetime({ offset: true }),
  date: DateKeySchema,
  audioFile: z.string().min(1),
  transcriptFile: z.string().min(1),
  speakers: z.tuple([z.string().min(1), z.string().min(1)]),
  expectedThemes: z.array(z.string().min(1)).min(1),
  expectedMemoryTypes: z.array(z.string().min(1)).min(1),
  expectedRelationshipSignals: z.array(z.string().min(1))
});

export const FixtureManifestSchema = z.object({
  datasetVersion: z.string().min(1),
  description: z.string().min(1),
  timezone: z.string().min(1),
  productionDateField: z.literal("recordingDate"),
  sessions: z.array(FixtureSessionSchema).min(1)
});

const ExpectedAssertionSchema = z.object({
  id: z.string().min(1),
  assertion: z.string().min(1),
  sourceSessions: z.array(z.string().min(1)).optional()
});

export const FixtureExpectedResultsSchema = z.object({
  datasetVersion: z.string().min(1),
  evaluationMode: z.string().min(1),
  must: z.array(ExpectedAssertionSchema),
  should: z.array(ExpectedAssertionSchema),
  mustNot: z.array(z.string().min(1)),
  relationMatrix: z.array(z.object({
    story: z.string().min(1),
    sourceSession: z.string().min(1),
    targetSession: z.string().min(1),
    acceptedRelations: z.array(z.string().min(1)),
    acceptedStatusOutcome: z.string().min(1).optional(),
    acceptedMergeOutcome: z.string().min(1).optional(),
    level: z.enum(["must", "should"])
  })),
  scopeExpectations: z.object({
    referenceDate: DateKeySchema,
    current: z.object({
      includedDates: z.array(DateKeySchema),
      excludedDates: z.array(DateKeySchema)
    }),
    week: z.object({
      range: z.object({ start: DateKeySchema, end: DateKeySchema }),
      includedDates: z.array(DateKeySchema),
      excludedDates: z.array(DateKeySchema)
    }),
    all: z.object({ includedDates: z.array(DateKeySchema) })
  })
});

export type FixtureSession = z.infer<typeof FixtureSessionSchema>;
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
export type FixtureExpectedResults = z.infer<typeof FixtureExpectedResultsSchema>;

export type FixtureDataset = {
  rootDir: string;
  manifest: FixtureManifest;
  expected: FixtureExpectedResults;
};
