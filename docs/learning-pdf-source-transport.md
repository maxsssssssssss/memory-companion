# Learning PDF original transport

This change fixes repeated cross-server transmission of the complete PDF for
every physical page. It does not change ParsedDocument, OCR models, physical
page numbering, source geometry, quality admission, or the product upload limit.

## Service contract

The application uses the configured authenticated service prefix. Health must
retain the existing service/instance identity and advertise
`pdf_source_transport` version `v1`, method `PUT`, byte/count/cache limits, TTL,
and upload timeout. The agreed server settings are 64 MiB per original, eight
sources, 512 MiB total, two hours from ready, and 600 seconds per upload.
No capability means no new original or parse submission; there is no fallback
to one Base64 original per page.

`PUT /pdf-sources/{source_id}` sends the original binary bytes with exact
Content-Length and Content-Type application/pdf. Required binding headers are
X-OCR-Document-ID, X-OCR-SHA256, X-OCR-Service-Epoch, X-OCR-Instance, plus the
existing server-side Bearer credential. The source UUID is saved before sending.

The PUT/GET receipt contains source_id, document_id, sha256, bytes,
physical_page_count, service_epoch, instance, status, created_at, expires_at.
The application compares the binding with its account-owned immutable original;
a server ID or hash does not grant local access. Status is uploading, ready,
failed, deleted, or expired. Uploading may have null page count and expiry.
The deployed adapter may return GET410 with only
`{error:"source_deleted"|"source_expired",accepted:false}`. For the exact saved,
authenticated source URL this means terminal and not reusable. It does not
resolve any page's unknown OCR outcome, and is never permission to PUT that ID
again. Unknown IDs (404) and other lookup failures remain ambiguous.

`POST /parse-pdf` sends source_id instead of pdf_base64; the two are mutually
exclusive. Request ID, original hash, one original physical page, recognition
profile, and expected instance/epoch remain unchanged. A source or transport
rejection is known unaccepted only for a complete 4xx receipt with accepted:false,
an allowed error, and matching request_id/document_id/sha256/pages/service_epoch/
instance. Mismatches, interrupted responses and network uncertainty stay unknown.
There is no automatic retry.

Uploads use a product-owned native Node HTTP request with a 600-second maximum
end-to-end abort, ordinary TLS verification and no redirects/retries. This avoids
native fetch's separate 300-second header timer shortening the advertised upload
deadline. Page recognition retains its independent four-minute deadline. Receipt
bodies are bounded to 64 KiB; page results retain the existing 8 MiB bound.

## Persistence and recovery

SQLite migration 11 adds metadata-only learning_pdf_sources. The existing
per-page request checkpoints and execution leases remain authoritative. Unknown
old page requests are queried by their original request IDs before preparing a
new source. HTTP404, a different instance, a new upload, or cache expiry never
proves an OCR request was not executed.

An ambiguous upload is queried using its persisted source ID. It is not uploaded
again automatically. Confirmed failed/expired sources may receive a new ID on
explicit continuation; unsent page request IDs are preserved. Completed pages
are reused. An unfinished upload does not mark any page submitted to OCR.

Successful completion of all requested pages atomically retires that source
before releasing publication ownership, then deletes its remote cached original.
Partial/unknown work retains the handle for continuation. Removing the remote
transport copy does not remove the account's original PDF or saved results.

Material/page deletion records cleanup intent before erasing local source
content. Late uploads cannot become usable. DELETE /pdf-sources/{source_id}
revokes the remote copy without stopping the OCR instance. A complete matching
deleted receipt confirms cleanup; 404 or transport failure keeps pending cleanup
metadata. Repeated deletion and the active request's finally block can finish
cleanup. A process crash with no later operation relies on the server TTL; no
background cleanup worker is introduced. Never call the legacy request cancel
endpoint to delete a material: that endpoint can stop the shared instance.

## Deployment and evidence boundaries

Deploy the CPU transport adapter in front of the same existing OCR instance;
retain old request/result lookup and service epoch during the cutover. Then
deploy the core patch against main 405b1f86e16a0f1514beab81d4945c7b32eb60b6.
The existing secure client configuration points to the resulting authenticated
prefix; no credential belongs in this repository or patch artifact.

Local verification uses isolated databases, synthetic HTTP/mocks and existing
offline parser fixtures. It is not live OCR, target-host acceptance, or proof of
OCR semantic quality. Live verification and deployment belong to Server deploy
under its own authorization. Never reissue the current unknown production page
merely to exercise this new transport.
