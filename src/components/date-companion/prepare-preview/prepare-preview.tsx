"use client";
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MotionConfig } from 'motion/react';
import { Notebook } from '../prepare-notebook/notebook';
import { createPreviewAdapter } from './adapter';
import { previewScenarios } from './fixtures';
const formal = 'http://127.0.0.1:4206';
function Arrow(){return <span aria-hidden="true">→</span>;}
export function PreparePreview(){
  const [adapter] = useState(()=>createPreviewAdapter({scenario:new URLSearchParams(location.search).get('case')??'normal',accountId:new URLSearchParams(location.search).get('account')??'preview-reader'}));
  const snapshot=useSyncExternalStore(adapter.subscribe,adapter.getSnapshot,adapter.getSnapshot);
  const [index]=useState(()=>new URLSearchParams(location.search).has('fixtures'));
  useEffect(()=>{void adapter.load().catch(()=>{});return ()=>adapter.dispose();},[adapter]);
  if(index) return <FixtureIndex/>;
  if(snapshot.loggedOut) return <div className="prep-app"><main className="prep-signed-out"><h1>已退出这本手帐</h1><p>这个虚构账号的样稿讨论、选择与草稿已清除。正式账号没有退出。</p><a className="prep-button" href="?fixtures=1">返回样例索引</a><a className="prep-button prep-primary" href="?case=normal&account=another-reader">用另一个虚构账号打开</a></main></div>;
  return <MotionConfig reducedMotion="user"><Notebook adapter={adapter} previewProductOrigin={formal}/></MotionConfig>;
}

function FixtureIndex(){return <div className="prep-app"><main className="prep-fixture-index"><a href="?case=normal">打开对开手帐<Arrow/></a><h1>准备手帐 · 样例目录</h1><p>第一阶段交互样稿。以下资料均为虚构，各场景独立保存在本浏览器，不读取或写入正式准备服务。</p><p>正常场景可长期亲试。自动验收使用独立账号，不会改动你的样稿输入。</p>{Array.from(new Set(previewScenarios.map(s=>s.group))).map(group=><section key={group}><h2>{group}</h2><div className="prep-fixture-grid">{previewScenarios.filter(s=>s.group===group).map(s=><a key={s.id} href={`?case=${s.id}`}><h3>{s.name}<Arrow/></h3><p>{s.description}</p><small>{s.trigger}</small></a>)}</div></section>)}<p>不提供导出、打印、提醒、整页保存、声音授权。</p><a href={formal+'/date-companion/a/prepare'}>打开正式准备手帐</a></main></div>;}
