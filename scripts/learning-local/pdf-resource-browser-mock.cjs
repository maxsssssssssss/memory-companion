// Explicit synthetic browser-test preload. Never configured in user runtimes.
const fs = require('node:fs'), path = require('node:path');
const root = process.env.LEARNING_PDF_RESOURCE_MOCK_OUTPUT;
if (!root) throw Error('Missing isolated PDF browser fixture directory');
const servicePrefix = 'https://ocr.synthetic.invalid/internal/ocr/';
const upstream = globalThis.fetch;
const log = entry => fs.appendFileSync(path.join(root, 'pdf-mock-calls.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n');
globalThis.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(servicePrefix)) {
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url)) return upstream(input, init);
    throw Error('Synthetic browser runner forbids external Provider requests');
  }
  const method = init?.method ?? 'GET';
  const endpoint = url.slice(servicePrefix.length), pathname = new URL(url).pathname;
  if (new Headers(init?.headers).get('authorization') !== 'Bearer SYNTHETIC_ONLY' || init?.redirect !== 'error') throw Error('Synthetic PDF requests require authenticated no-redirect transport');
  const record = entry => log({ method, path: pathname, ...entry });
  if (method === 'DELETE' && /^results\/[a-zA-Z0-9_.:-]+$/.test(endpoint)) { record({ kind: 'cleanup' }); return Response.json({ deleted: true }); }
  if (method === 'GET' && endpoint === 'health') {
    const control = JSON.parse(fs.readFileSync(path.join(root, 'mock-control.json'), 'utf8'));
    record({ kind: 'health', accepting: control.mode === 'ready' });
    return Response.json({ service_version: 'ocr-pdf-trial-0.1', resource_policy_version: 'learning-ocr-resource-v1', service_epoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', instance: 'session-99', ready: true, admission: { accepting: control.mode === 'ready' }, active_request: null });
  }
  if (method === 'GET' && /^requests\/[a-zA-Z0-9_.:-]+(?:\/result)?$/.test(endpoint)) { record({ kind: endpoint.endsWith('/result') ? 'result' : 'lookup' }); return Response.json({ status: 'not_found' }, { status: 404 }); }
  if (endpoint !== 'parse-pdf' || method !== 'POST') throw Error('Unexpected synthetic PDF request');
  const r = JSON.parse(init.body), n = r.page_range.start;
  if (r.page_range.end !== n || !Buffer.from(r.pdf_base64, 'base64').includes(Buffer.from('SYNTHETIC-TEST-ONLY'))) throw Error('Only one-page synthetic PDFs are allowed');
  const control = JSON.parse(fs.readFileSync(path.join(root, 'mock-control.json'), 'utf8'));
  const identity = { requestId: r.request_id, materialId: r.document_id, sha256: r.sha256, page: n };
  if (n === 2 && control.mode === 'resource-wait') {
    record({ kind: 'post', result: 'not_accepted', ...identity });
    return Response.json({ request_id: r.request_id, status: 'not_accepted', accepted: false, reason: 'resource_wait', retry_after_seconds: 30,
      instance: 'session-99', service_epoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', document_id: r.document_id, sha256: r.sha256, pages: [n] }, { status: 503 });
  }
  if (n === 2 && control.mode === 'known-failure') {
    record({ kind: 'post', result: 'failed', ...identity });
    return Response.json({ request_id: r.request_id, status: 'failed' }, { status: 503 });
  }
  if (n === 2 && control.mode === 'unknown') { record({ kind: 'post', result: 'unknown', ...identity }); throw Error('SYNTHETIC transport outcome unknown'); }
  record({ kind: 'post', result: 'completed', ...identity });
  const text = '[合成测试] 只有满足适用前提，才能使用规则；未完成页面不能当作已解析。此文字是明确标记的浏览器替身，不是 OCR 结果。';
  const bbox = [40, 65, 550, 110];
  const rotated = false, width = 600, height = 800;
  const blocks = [{ block_id: 1, type: 'text', raw_content: text, content: text, bbox, order: 1, polygon_points: null,
    sources: [{ document_sha256: r.sha256, physical_page: n, bbox }], quality: { status: 'unverified', warnings: [] } }];
  return Response.json({ service_version: 'ocr-pdf-trial-0.1', request_id: r.request_id, status: 'completed', publishable: true,
    service_epoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', instance: 'session-99',
    document: { document_id: r.document_id, sha256: r.sha256, physical_page_count: 3, selected_physical_pages: [n], selected_pdf_sha256: r.sha256 },
    pages: [{ physical_page: n, page_index: n - 1, selection_index: 0, render_size: { width, height },
      pdf_geometry: { physical_page: n, mediabox_pt: [0, 0, 600, 800], cropbox_pt: rotated ? [10, 20, 590, 780] : [0, 0, 600, 800], rotation_degrees: rotated ? 90 : 0, display_size_pt: [width, height] }, blocks,
      coverage: { detected_regions: 1, output_blocks: 1, vl_requests: 0, semantic_completeness: 'unverified', issues: [] },
      raw_paddle: { prunedResult: { parsing_res_list: [{ block_id: 1, block_content: text, block_label: 'text', block_bbox: bbox }] } }, status: 'completed', quality_status: 'unverified' }],
    coverage: { requested_pages: 1, completed_pages: 1, partial: false, failures: [], semantic_completeness: 'unverified' },
    parser: { paddleocr: 'SYNTHETIC', paddlex: 'SYNTHETIC', model: 'UI MOCK NO OCR', backend: 'in-memory', profile: {} }, authorization: 'SYNTHETIC ONLY' });
};
