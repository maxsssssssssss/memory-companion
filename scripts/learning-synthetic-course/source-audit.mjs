import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createCanvas,loadImage} from '@napi-rs/canvas';
const root=path.resolve('output/learning-synthetic-course-20260923'),all=[];
for(const [phase,name]of[['first','课程课件.pdf'],['second','追加课件.pdf']]){
 if(!fs.existsSync(root+'/parse-'+phase+'.json'))continue;
 const doc=JSON.parse(fs.readFileSync(root+'/parse-'+phase+'.json','utf8')).value.document;
 assert.equal(doc.originalSha256,createHash('sha256').update(fs.readFileSync(root+'/inputs/'+name)).digest('hex'));
 const contact=createCanvas(900,Math.ceil(doc.pages.length/3)*424),c=contact.getContext('2d');c.fillStyle='white';c.fillRect(0,0,contact.width,contact.height);
 for(const page of doc.pages){
  const original=await loadImage(root+'/screenshots/pdf-'+name+'-'+page.physical_page+'.png'),out=createCanvas(original.width,original.height),ctx=out.getContext('2d');ctx.drawImage(original,0,0);
  const regions=[];for(const [i,block]of page.blocks.entries())for(const region of block.source_regions){
   assert.equal(region.physical_page,page.physical_page);assert.equal(region.unit,'render_pixel');
   const [l,t,r,b]=region.bbox,W=page.render.width_px,H=page.render.height_px;
   assert(l>=0&&t>=0&&r<=W&&b<=H&&l<r&&t<b);
   const box=[l/W*original.width,t/H*original.height,(r-l)/W*original.width,(b-t)/H*original.height];ctx.strokeStyle=block.quality.status==='warning'?'#d47000':'#00795d';ctx.lineWidth=2;ctx.strokeRect(...box);ctx.font='12px sans-serif';ctx.fillStyle=ctx.strokeStyle;ctx.fillText(String(i+1),box[0],Math.max(12,box[1]));
   regions.push({blockId:block.id,physicalPage:page.physical_page,render:[W,H],originalPreview:[original.width,original.height],box,contentHash:block.content_sha256,sourceHash:block.source_sha256});
  }
  fs.writeFileSync(root+'/screenshots/overlay-'+phase+'-'+page.physical_page+'.png',out.toBuffer('image/png'));c.drawImage(out,((page.physical_page-1)%3)*300,Math.floor((page.physical_page-1)/3)*424,300,424);all.push({phase,physicalPage:page.physical_page,regions});
 }
 fs.writeFileSync(root+'/screenshots/overlay-contact-'+phase+'.png',contact.toBuffer('image/png'));
}
fs.writeFileSync(root+'/source-geometry.json',JSON.stringify({calculationChecks:'PASS',visualReview:'pending human/model image inspection; not implied by bounds',pages:all},null,2));
console.log(JSON.stringify({pages:all.length,regions:all.reduce((n,p)=>n+p.regions.length,0)}));
