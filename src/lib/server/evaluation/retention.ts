export const EVALUATION_DELETE_CONFIRMATION_HEADER = "x-evaluation-delete-confirmed";
export const EVALUATION_RETENTION_REQUEST_HEADER = "x-evaluation-retention";

export type EvaluationRetainedUpload = {
  evaluationRetention?: boolean;
};

export function isEvaluationMode(value = process.env.EVALUATION_MODE) {
  return value?.trim().toLowerCase() === "true";
}

function headerIsTrue(request: Request, name: string) {
  return request.headers?.get(name)?.trim().toLowerCase() === "true";
}

export function shouldMarkUploadForEvaluationRetention(
  request: Request,
  value = process.env.EVALUATION_MODE
) {
  return isEvaluationMode(value) && headerIsTrue(request, EVALUATION_RETENTION_REQUEST_HEADER);
}

export function isEvaluationRetentionUpload(
  upload: EvaluationRetainedUpload,
  value = process.env.EVALUATION_MODE
) {
  return isEvaluationMode(value) && upload.evaluationRetention === true;
}

export function isConfirmedEvaluationDelete(request: Request) {
  return headerIsTrue(request, EVALUATION_DELETE_CONFIRMATION_HEADER);
}
