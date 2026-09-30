// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfParserConfig } from "./pdf-parser-service";

let root:string,findings:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"learning-ocr-config-"));findings=join(root,"findings.json");writeFileSync(findings,"[]");});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const base="https://ocr.synthetic.invalid/internal/ocr";
const token="SYNTHETIC_ONLY_NOT_A_CREDENTIAL";
const environment=(url=base)=>({LEARNING_PDF_SERVICE_URL:url,LEARNING_PDF_SERVICE_TOKEN:token,LEARNING_PDF_KNOWN_FINDINGS_FILE:findings});
function connection(overrides:Record<string,unknown>={}){
  const file=join(root,"client.json"),key=join(root,"api-key");writeFileSync(key,token+"\n",{mode:0o600});
  writeFileSync(file,JSON.stringify({base_url:base+"/",authentication:"Bearer",token_file:key,tls_verify:true,automatic_request_retries:0,instance_binding_required:true,...overrides}),{mode:0o600});
  return {file,key,env:{LEARNING_PDF_SERVICE_CONFIG_FILE:file,LEARNING_PDF_KNOWN_FINDINGS_FILE:findings}};
}
it.each([base,base+"/","https://ocr.synthetic.invalid:443/internal/ocr/"])("preserves one normalized authenticated gateway prefix: %s",url=>{
  expect(pdfParserConfig(environment(url))).toMatchObject({url:base,token,discoverInstance:true});
});
it.each(["https://ocr.synthetic.invalid","https://ocr.synthetic.invalid/","http://127.0.0.1:37913/"])("retains existing origin and loopback behavior: %s",url=>{
  expect(pdfParserConfig(environment(url)).url).toBe(new URL(url).origin);
});
it.each(["/internal/../ocr","/internal/./ocr","/internal/%2e%2e/ocr","/internal/%2Focr","//internal/ocr","/internal//ocr","/internal/ocr//","/internal\\ocr","/internal/ocr?key=private","/internal/ocr#private"])("rejects ambiguous or escaping configured path: %s",suffix=>{
  expect(()=>pdfParserConfig(environment("https://ocr.synthetic.invalid"+suffix))).toThrow("pdf_parser_config_invalid");
});
it("loads the delivered server client file and reads its separate key without storing credentials in JSON",()=>{
  const {env}=connection();expect(pdfParserConfig(env)).toMatchObject({url:base,token,findings:[],discoverInstance:true});
});
it("supports a server-owned token file with an explicit URL",()=>{
  const {key}=connection();expect(pdfParserConfig({LEARNING_PDF_SERVICE_URL:base,LEARNING_PDF_SERVICE_TOKEN_FILE:key,LEARNING_PDF_KNOWN_FINDINGS_FILE:findings}).token).toBe(token);
});
it.each(["LEARNING_PDF_SERVICE_URL","LEARNING_PDF_SERVICE_TOKEN","LEARNING_PDF_SERVICE_TOKEN_FILE"])("rejects mixed connection authorities: %s",name=>{
  const {env}=connection();expect(()=>pdfParserConfig({...env,[name]:"SYNTHETIC_OTHER_CONFIGURATION"})).toThrow("pdf_parser_config_invalid");
});
it("rejects two token sources instead of choosing silently",()=>{
  const {key}=connection();expect(()=>pdfParserConfig({...environment(),LEARNING_PDF_SERVICE_TOKEN_FILE:key})).toThrow("pdf_parser_config_invalid");
});
it.each([{tls_verify:false},{automatic_request_retries:1},{instance_binding_required:false},{authentication:"Basic"},{base_url:"http://127.0.0.1:1"},{token_file:"relative.key"}])("keeps delivered secure connection requirements: %j",value=>{
  expect(()=>pdfParserConfig(connection(value).env)).toThrow("pdf_parser_config_invalid");
});
it.each(["missing-config","oversized-config","invalid-config","missing-token","oversized-token","invalid-token"])("fails closed without exposing filesystem paths or key bytes: %s",kind=>{
  const {env,file,key}=connection();
  if(kind==="missing-config")rmSync(file);
  if(kind==="oversized-config")writeFileSync(file," ".repeat(16385));
  if(kind==="invalid-config")writeFileSync(file,"SYNTHETIC_PRIVATE_CONFIG");
  if(kind==="missing-token")rmSync(key);
  if(kind==="oversized-token")writeFileSync(key,"SYNTHETIC_PRIVATE_TOKEN".repeat(300));
  if(kind==="invalid-token")writeFileSync(key,"SYNTHETIC_PRIVATE_TOKEN\nInjected: invalid");
  try{pdfParserConfig(env);throw new Error("accepted_invalid_configuration");}
  catch(error){expect((error as Error).message).toBe("pdf_parser_config_invalid");expect((error as Error).message).not.toContain(root);}
});
it("reads current key bytes on each operation, allowing server rotation without caching an old key",()=>{
  const {env,key}=connection();expect(pdfParserConfig(env).token).toBe(token);writeFileSync(key,"SYNTHETIC_ROTATED_TOKEN\n");
  expect(pdfParserConfig(env).token).toBe("SYNTHETIC_ROTATED_TOKEN");
});
it.each(["SYNTHETIC\u0000TOKEN","SYNTHETIC中文TOKEN","SYNTHETIC\u007fTOKEN"])("rejects non-header token bytes before transport or checkpoints are possible",badToken=>{
  expect(()=>pdfParserConfig({...environment(),LEARNING_PDF_SERVICE_TOKEN:badToken})).toThrow("pdf_parser_config_invalid");
  const {env,key}=connection();writeFileSync(key,badToken);expect(()=>pdfParserConfig(env)).toThrow("pdf_parser_config_invalid");
});
