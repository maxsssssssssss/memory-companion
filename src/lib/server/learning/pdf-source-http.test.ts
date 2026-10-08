// @vitest-environment node
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { pdfParserTransport } from "./pdf-source-http";

let server:Server|undefined;
afterEach(async()=>{vi.unstubAllGlobals();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
async function listen(handler:RequestListener) {
  server=createServer(handler);server.listen(0,"127.0.0.1");await once(server,"listening");
  return `http://127.0.0.1:${(server.address() as {port:number}).port}/pdf-sources/synthetic`;
}
function upload(body=new Uint8Array([37,80,68,70]),signal=AbortSignal.timeout(1000)):RequestInit {
  return {method:"PUT",body,signal,headers:{"Content-Type":"application/pdf","Content-Length":String(body.length),Authorization:"Bearer SYNTHETIC_ONLY"}};
}
it("sends exact binary through native HTTP and preserves response without native fetch's shorter header timer",async()=>{
  const fake=vi.fn(()=>{throw Error("fetch must not handle upload");});vi.stubGlobal("fetch",fake);
  let received=Buffer.alloc(0);
  const url=await listen((request,response)=>{
    expect(request.headers.authorization).toBe("Bearer SYNTHETIC_ONLY");
    request.on("data",chunk=>{received=Buffer.concat([received,chunk]);});request.on("end",()=>{response.writeHead(201,{"Content-Type":"application/json"});response.end('{"status":"ready"}');});
  });
  const response=await pdfParserTransport(url,upload());expect(response.status).toBe(201);expect(await response.json()).toEqual({status:"ready"});
  expect(received.equals(Buffer.from([37,80,68,70]))).toBe(true);expect(fake).not.toHaveBeenCalled();
});
it("uses a bounded end-to-end abort, never retries a stalled upload",async()=>{
  let calls=0;const url=await listen(()=>{calls++;});
  await expect(pdfParserTransport(url,upload(undefined,AbortSignal.timeout(40)))).rejects.toMatchObject({name:"AbortError"});expect(calls).toBe(1);
});
it("does not follow redirects or release credentials to another path",async()=>{
  let calls=0;const url=await listen((_request,response)=>{calls++;response.writeHead(307,{Location:"https://different.invalid/collect"});response.end();});
  const response=await pdfParserTransport(url,upload());expect(response.status).toBe(307);expect(calls).toBe(1);
});
it("bounds upload receipt bodies",async()=>{
  const url=await listen((_request,response)=>{response.writeHead(201);response.end("x".repeat(65537));});
  await expect(pdfParserTransport(url,upload())).rejects.toThrow("oversized_response");
});
it("rejects a truncated HTTP upload receipt instead of confirming an incomplete response",async()=>{
  const url=await listen((_request,response)=>{response.writeHead(201,{"Content-Length":"100"});response.write('{"sta');setImmediate(()=>response.destroy());});
  await expect(pdfParserTransport(url,upload())).rejects.toThrow();
});
it("keeps ordinary health/parse fetch behavior and refuses non-loopback plaintext upload",async()=>{
  const fake=vi.fn<typeof fetch>(async()=>Response.json({ready:true}));vi.stubGlobal("fetch",fake);
  await pdfParserTransport("https://synthetic.invalid/health");expect(fake).toHaveBeenCalledOnce();
  await expect(pdfParserTransport("http://external.invalid/pdf-sources/synthetic",upload())).rejects.toThrow("invalid_pdf_upload_endpoint");
});
