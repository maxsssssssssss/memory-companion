import { z } from "zod";

import {
  WorkReviewIdSchema,
  WorkReviewIsoDateTimeSchema,
  WorkReviewVersionSchema
} from "./work-review";

export const WORK_PROJECT_CONTRACT_VERSION = 1 as const;
export const WORK_PROJECT_MAX_LINKS = 3 as const;

export const WorkProjectStatusSchema = z.enum(["active", "archived"]);
export const WorkProjectNameSchema = z.string().trim().min(1).max(120);
export const WorkProjectDescriptionSchema = z.string().max(2_000);

export const WorkProjectSchema = z.object({
  contractVersion: z.literal(WORK_PROJECT_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  name: WorkProjectNameSchema,
  description: WorkProjectDescriptionSchema.nullable(),
  status: WorkProjectStatusSchema,
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema,
  archivedAt: WorkReviewIsoDateTimeSchema.nullable()
}).strict();

export const WorkProjectReferenceSchema = WorkProjectSchema.pick({
  id: true,
  name: true,
  status: true,
  version: true
});

export const CreateWorkProjectRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  name: WorkProjectNameSchema,
  description: WorkProjectDescriptionSchema.nullable().optional()
}).strict();

export const UpdateWorkProjectRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema,
  name: WorkProjectNameSchema.optional(),
  description: WorkProjectDescriptionSchema.nullable().optional(),
  status: WorkProjectStatusSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.name === undefined && value.description === undefined && value.status === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Project update requires at least one mutable field"
    });
  }
});

export const WorkProjectIdsSchema = z.array(WorkReviewIdSchema)
  .max(WORK_PROJECT_MAX_LINKS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Project IDs must be unique"
      });
    }
  });

export const DeleteWorkProjectRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema
}).strict();

export const SetWorkResourceProjectsRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema,
  projectIds: WorkProjectIdsSchema
}).strict();

export const WorkProjectListStatusSchema = z.enum(["active", "archived", "all"]);

export const WorkProjectScopeFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("unassigned") }).strict(),
  z.object({ kind: z.literal("project"), projectId: WorkReviewIdSchema }).strict()
]);

export function normalizeWorkProjectName(value: string) {
  return WorkProjectNameSchema.parse(value)
    .normalize("NFKC")
    .toLocaleUpperCase("en-US")
    .toLocaleLowerCase("en-US")
    .replaceAll("ß", "ss")
    .normalize("NFKC");
}

export type WorkProjectStatus = z.infer<typeof WorkProjectStatusSchema>;
export type WorkProject = z.infer<typeof WorkProjectSchema>;
export type WorkProjectReference = z.infer<typeof WorkProjectReferenceSchema>;
export type CreateWorkProjectRequest = z.infer<typeof CreateWorkProjectRequestSchema>;
export type UpdateWorkProjectRequest = z.infer<typeof UpdateWorkProjectRequestSchema>;
export type DeleteWorkProjectRequest = z.infer<typeof DeleteWorkProjectRequestSchema>;
export type SetWorkResourceProjectsRequest = z.infer<
  typeof SetWorkResourceProjectsRequestSchema
>;
export type WorkProjectListStatus = z.infer<typeof WorkProjectListStatusSchema>;
export type WorkProjectScopeFilter = z.infer<typeof WorkProjectScopeFilterSchema>;
