// Synthetic course authoring only: no Provider requests, no application writes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';

const root = path.resolve(process.argv[2] || 'output/learning-synthetic-course-20260923');
const inputs = path.join(root, 'inputs'), review = path.join(root, 'review-only');
for (const p of [inputs, review, path.join(root, 'screenshots')]) fs.mkdirSync(p, { recursive: true });
if (fs.existsSync(root + '/frozen.sha256')) throw Error('Course is frozen; create a new version rather than overwrite it');
const pages = [
  ['纸上展览工坊', '从展项到参观节奏',
    '这是一门合成课程。青禾社团准备在纸上设计一场关于日常物件的小展览。我们用明确的虚构规则练习分类、比较和安排顺序，规则不是建筑、消防或博物馆行业标准，不应用于真实场地安全判断。',
    '课程的三个问题是：观众先需要知道什么，两个展项能否放在同一区，以及一组观众什么时候可以进入下一站。设计结果必须能解释理由，不能只给一个数字。',
    '本课的“站”是一个讲解单元，不是房间。不同站可以在一张平面图上相邻，讲解仍按课程路线进行。课件给出基本规则，录音补充实际安排，课堂笔记保留现场记录与尚未解决的疑问。'],
  ['第一章 · 展项与线索', '一个主题可以有不同证据',
    '展项 Exhibit 是观众可观察的一件物品、一个模型或一组明确关联的图片。主题 Theme 是希望观众理解的问题。线索 Clue 是展项中能支持解释的具体特征；展项名称本身不等于线索。',
    '例如主题是“记录如何留下痕迹”。铅笔写在纸上的深浅变化是一条线索，纸张的折痕是另一条线索。“一支铅笔”只是名称；只有说明观众观察什么，才形成教学线索。',
    '本课程把展项角色分成起点、比较和延伸。起点介绍术语，比较呈现差异，延伸提出新问题。角色与价值无关，延伸展项并不天然比起点更重要。'],
  ['第一章 · 前置关系', '能看见，不等于能理解',
    '若理解展项乙必须先知道展项甲引入的术语，则甲是乙的前置。路线中甲应先于乙，但不要求两者空间上直接相邻。只有题材相近，不能据此断言存在前置关系。',
    '纸纤维模型介绍“方向”；折纸样本比较沿纹与横纹的折痕。因此模型先于折纸样本。彩色信封虽然也由纸制成，但这不足以证明信封必须放在模型之后。',
    '下图箭头只表示本课程给定的理解顺序，不表示距离、优劣或保证每个人都能理解。路线可以插入休息点，不能颠倒已经明确的前置。',
    '<svg viewBox="0 0 900 135"><rect x="10" y="25" width="250" height="80" rx="12"/><rect x="325" y="25" width="250" height="80" rx="12"/><rect x="640" y="25" width="250" height="80" rx="12"/><text x="135" y="72">纸纤维模型</text><text x="450" y="72">折纸样本</text><text x="765" y="72">新问题</text><path d="M268 65H315M578 65H630"/></svg>'],
  ['第二章 · 分区', '相邻的理由必须说清',
    '在本课程中，共同讨论一个具体问题、并且展示方式互不干扰的展项，可以放入同一区。题材相同只是候选线索，不是分区的充分条件。需要安静听音的展项与必须敲击的展项不放在同一区。',
    '“纸的形状”区可以放折纸与纸桥，前提是二者都围绕形状如何改变支撑方式进行比较。把所有纸制品都放在这里，会让共同问题变得含糊。',
    '分区与路线是两个决策。分区回答哪些内容放在一起；路线回答先学什么、后学什么。先完成分区不意味着前置关系已经解决。'],
  ['第二章 · 展项资料表', '表中条件不能被名称替代',
    '下面是这次纸上练习的固定展项资料。预计讲解时间只包含讲解，不包含站间移动和整理。时间相同不代表内容可以互换。',
    '<table><thead><tr><th>展项</th><th>主要问题</th><th>讲解分钟</th><th>条件</th></tr></thead><tbody><tr><td>纸纤维模型</td><td>方向如何描述</td><td>3</td><td>起点术语</td></tr><tr><td>折纸样本</td><td>折痕有什么差别</td><td>4</td><td>先理解方向</td></tr><tr><td>纸桥模型</td><td>形状怎样改变支撑</td><td>5</td><td>仅观察，不承重实验</td></tr><tr><td>声音明信片</td><td>声音如何记录</td><td>4</td><td>需要安静听音</td></tr></tbody></table>',
    '纸桥模型中的“五分钟”不是任何纸桥活动的通用时长。若活动增加真实制作，本表不能直接作为新的安排依据。'],
  ['第三章 · 时间预算', '先确认适用范围，再计算',
    '本课程的基本路线面向一组观众、依次经过三个站、同一位讲解者带队且不重复返回旧站。只有这些前提成立，才使用基本时间规则。多个组同时活动不在这条规则的范围内。',
    '总时长 T = 各站讲解分钟之和 + 移动分钟 + 整理分钟。三站路线有两次站间移动，每次按 2 分钟计；路线结束整理固定 3 分钟。这些是本次模拟的约定，不是真实通行速度测量。',
    '若三站讲解分别为 3、4、5 分钟，T = 3 + 4 + 5 + 2 × 2 + 3 = 19 分钟。仅相加得到 12 分钟会漏掉移动与整理。改变站数、队伍数或返回安排时，不能机械照搬 19 分钟。'],
  ['第三章 · 可行性与例外', '未满足前提，不是计算后超时',
    '纸上活动给基本路线的时间上限是 22 分钟。前提成立且算得 T 不超过 22 分钟，才可称为“通过本次时间检查”。这不等于通过真实安全检查，也不保证理解效果。',
    '小组选择纸纤维模型、折纸样本和纸桥模型，依次前进，不回头，计算得到 19 分钟，可以通过本次时间检查。若临时回到模型站，已不符合不返回的前提，需要重新设计移动安排，不能简单称为原规则下的超时。',
    '一个设计可以时间合格但教学顺序不合理，也可以顺序合理却尚不能计算时间。请分别记录问题所在，不把所有问题压缩为“合格”或“不合格”。'],
  ['第四章 · 团体通行', '另一个规则，不套用单组公式',
    '团体模式使用 Slot 时间格安排。一个时间格为 5 分钟，包含本站讲解和下一步准备，不能再叠加基本路线中的每次移动 2 分钟。两种规则描述不同安排，不能混合计算。',
    '每站每个时间格最多容纳 2 组。进入下一站之前，先检查下一格是否有位置。没有位置时在等待区保留原顺序，等待不是进入；不能把等待区人数当作已经占用下一站。',
    '只有已完成本站讲解的小组可以申请下一站。空位只是一个条件，不足以让尚未完成本站的小组提前离开。等待区在本课中只是调度概念，不代表真实场地空间标准。'],
  ['第四章 · 比较与解释', '用同一组事实检查方案',
    '方案青：模型、折纸、纸桥依次讲解，一组观众，三站且不返回。方案蓝：折纸在模型之前，其余条件相同。青满足给定前置；蓝虽可算出相同时间，仍颠倒了理解顺序。',
    '方案橙把声音明信片和敲击纸鼓放在同一区，只因两者都讨论声音。这种理由忽略了展示方式干扰；应另设区域或改变展示安排，而不是以题材一致直接放行。',
    '比较词必须附条件。“更快”要说明比较哪两条路线、包含哪些活动；“更易理解”在本课只能作为设计目的，不能由时间数字直接证明。'],
  ['课程小结', '留下可以回看的判断',
    '一个完整说明应区分材料中写明的规则、案例计算和仍待确认的记录。不要把未确认建议提升为正式规则，也不要在发现冲突时静默选取更方便的数字。',
    '整理展览方案时，先找主题和可观察线索，再说明分区与前置。单组基本路线检查适用范围后计算；团体模式检查时间格、本站完成情况与下一站位置。二者可以比较，不能互相代入。',
    '后续录音将给出额外的团体到达案例和讲解例外，课堂笔记另有现场观察。本课允许把不同来源联合起来推理，但每一步都应能回到相应的页、录音时间或笔记段落。']
];
const extra = [
  ['追加课 · 观察窗口', '新增概念：Window',
    '本页沿用前一批纸上展览的团体模式。观察窗口 Window 指连续两个时间格，供同一组观察展项的前后变化。它不是两个独立展项，也不把每站容量从 2 组扩大为 4 组。',
    '使用观察窗口时，同一组在两个时间格都占用该站的一个位置。第一格结束后不申请下一站，第二格完成后才申请。其他单格展项仍按原团体规则运行。',
    '这是“完成本站后才能申请下一站”的具体扩展，不推翻原有容量规则。某一格还有空位，也不能使观察窗口组提前结束任务。'],
  ['追加课 · 组合安排', '把新旧条件放在一起',
    '折影盒需要观察光线角度变化，指定使用两个连续时间格。若第 3 格开始，第 3、4 格均占一个位置，第 4 格结束后才可以申请下一站。',
    '若第 4 格该站已有另一组预约，折影盒组加上预约组正好 2 组，符合本课容量。不能只看第 3 格的空位，也不能把一次两格观察拆成两个不相关的小组。',
    '本追加只扩展团体模式，不改变基本单组路线的 22 分钟上限，也没有修改安静展项的分区原则。旧章节、个人笔记和先前练习应保留原记录。']
];
const notes = `合成课程课堂笔记：纸上展览工坊

这份笔记是本次课程的一份独立材料，不是学习软件中的个人笔记。所有活动规则都是虚构教学约定，不是行业标准。

现场补充记录：模型站准备了凸起的方向箭头卡。听音敏感的小组可以先用箭头卡描述观察，再决定是否参加声音明信片；跳过听音不等于没有完成方向术语学习。这条替代方式只记录在本笔记中。

待确认记录：有同学说团体模式每站每格可进入 3 组，这与课件写明的最多 2 组不同。教师尚未确认修改。请并列保留这两种说法，不把 3 组当作已生效规则，也不要据此出要求唯一容量答案的题。

现场观察：小组把纸桥称作“最牢的桥”，但本活动只观察形状，没有承重实验或测量，因此这句比较不能作为结果。记录可写成“纸桥模型用于讨论形状与支撑的关系”。

联合练习线索：录音的第二个团体到达案例可以结合课件的本站完成前提讨论。需要回到录音确认哪一组完成讲解，不能只看空位数。`;
const addText = `合成课程追加记录：观察窗口

折影盒的前后观察需要同一组连续保留位置。若组员中途离开，不能自动把两个不同小组的观察拼成同一组完成记录，需要重新安排并说明变化。

课堂提出一个还未实践的问题：等待组可否先看箭头卡？这是可讨论的教学补充，不应被写成已经执行的新排队规则。原队列顺序保持不变。

观察窗口与前一批录音中的团体到达案例可以联合分析，但不要把单组路线的 19 分钟案例当成时间格数。`;
const script = [
  '这是一段使用系统合成语音制作的课程讲解，不是真人授课，也不是行业标准。我们继续纸上展览工坊。今天重点解释课件留下的三个问题：观察和推断如何分开，团体进入下一站如何判断，以及遇到例外时为什么要把原因写清楚。请把这段录音作为补充材料；里面有课件没有完整写出的案例。我们使用分钟和时间格两种单位，听到数字时，先确认正在讨论哪一种安排。',
  '先说展项和线索。假设你面前是一张已经折过的纸。展项是这张纸，线索可以是折痕位置、深浅和方向。看见一条深折痕，并不能断定折纸者用了更大力气，因为纸的厚度和折叠次数也可能影响结果。在本课没有测量这些因素的时候，可以描述观察，却不要补写确定的原因。这不是要求什么都不解释，而是提醒我们把材料写明的事实和自己的猜测分开。讲解时可以说，这里值得比较折痕；不应直接说，这已经证明某个人用力更大。',
  '再看前置关系。课件先介绍方向，再比较沿纹和横纹，这是理解上的先后，不是要求两个模型挨在一起摆放。如果中间安排一处安静休息点，术语仍然可以先学，比较仍然可以后做。相反，把两个展项摆得很近，也不能补回缺失的术语讲解。一个常见误会是把路线图的箭头看成越往后越高级。本课没有这样的排名，箭头只是在特定解释任务里说明先需要什么。观众已经知道术语时，可以作不同安排，但应写明这个前提，不能悄悄把原路线删掉一站还称作同一案例。',
  '下面给一个只在录音中补充的数值案例。小组选择模型、折纸和声音明信片，讲解分别为三分钟、四分钟、四分钟。只有一组观众，同一位讲解者，不回头，一共三站。请把讲解的十一分钟、两次移动的四分钟以及结束整理的三分钟分开相加，得到十八分钟。十八没有超过本次二十二分钟上限，所以通过时间检查。但是这并不保证每个人都听清了录音，也不能证明理解效果比十九分钟的纸桥路线更好。十八和十九的差别只能在相同计时范围下比较，不能省略条件说前者全面更好。',
  '现在增加一个例外。若声音明信片需要临时调换设备，主持人决定多留四分钟准备。这四分钟是本案例额外安排，不能说课件已经把它包含在固定三分钟整理里。刚才的十八加四等于二十二，正好到达上限，不是超过。若准备需要五分钟，则合计二十三，才超过这次上限。不要因为两种方案都出现设备准备，就给它们同一个结果；也不要把正好等于上限说成不满足不超过。设备准备例外不改变前置关系，算时间的时候仍然必须先说明三站单组且不返回。',
  '接下来是团体模式。此时一个时间格为五分钟，包含本站讲解与下一步准备。我们不再另外添加课件基本路线里的每次移动两分钟。把两套规则混在一起，会多算时间。你可以把时间格想成一张预约表里的一个位置，但这个比喻只用于理解安排，不意味着真实博物馆也按这套方式运营。每站每格最多两组是课件给出的约定；如果课堂笔记记了不同数字，应该保留差异并等待确认，不能由我在录音里猜出新的正式规定。',
  '第一个团体案例只在录音里给出。下一格的纸桥站已经预约一组。松果组和海星组都已完成本站讲解，松果组先进入等待队列，海星组后到。按照课件的容量两个组，下一格只剩一个位置，因此松果组可以进入，海星组仍等待并保留顺序。海星组在等待区不等于已经进入纸桥站。我们需要把这段到达顺序与课件的容量和完成前提一起读，单看课件不知道谁先到，单听组名也算不出空位。若笔记中三组的说法尚未确认，就不能把两组都进入当成已经确定的新安排。',
  '第二个案例改变的不是空位，而是完成情况。下一格折纸站没有预约，两个位置都空着。石榴组仍在完成模型站讲解，风铃组已经完成。只有风铃组现在可以申请下一站，石榴组不能因为空位很多就提前离开。这是有空位但前提未满足，不是申请后被判断为容量超额。说清这一点很重要，因为后续行动不同：石榴组需要完成本站，不需要增加下一站容量。这段案例也是录音独有的，请不要把石榴组说成已经完成讲解。',
  '我们再讨论教学上的例外，而不是偷偷修改规则。如果某组听音不舒服，主持人可以暂停声音环节，确认其需要，再选择可观察的替代活动。暂停并不自动证明这组不愿学习，也不自动改变排队顺序。课堂笔记记录了一个具体替代工具，录音不重复它的名称；你需要把两份材料结合起来，才能说明这个工具如何支持方向术语学习。补充解释可以帮助理解，但应标成解释或例子，不冒充课件的原话。没有材料支持的效果，例如一定提高记忆力，不能因为听起来积极就加入结论。',
  '最后给出一种复盘方法。每当你想写一个判断，先找对象，再写前提，最后写实际结果。比如设备准备四分钟和五分钟，差一个分钟就可能跨过上限；比如等待和进入，看起来都在下一站附近，却是不同状态；比如尚未完成本站和容量不足，需要的调整也不同。讨论冲突时，可以列出课件、录音和课堂笔记分别怎么说，不能把尚待确认的记录默默改成正式规则。课程的目标不是记住几个组名，而是知道为什么同样的数字在不同条件下不能给出同一结论。下一批材料会介绍需要连续观察的展项，届时请保留今天的旧记录，检查新增概念到底改变了哪一个条件。'
].join('\n\n');

fs.writeFileSync(inputs + '/课堂笔记.txt', notes);
fs.writeFileSync(inputs + '/追加记录.txt', addText);
fs.writeFileSync(review + '/合成讲稿.txt', script);
fs.writeFileSync(review + '/authoring.json', JSON.stringify({ pages, extra }, null, 2));
const html = list => `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;color:#292d30;font-family:'Microsoft YaHei',sans-serif}.page{width:210mm;height:297mm;padding:22mm 19mm 18mm;break-after:page;position:relative}h1{font-size:27px;color:#476850;margin:12px 0 30px}h2{font-size:18px;margin:0;color:#776235}.tag{font-size:11px;letter-spacing:1px;color:#666}p{font-size:16px;line-height:1.85;margin:22px 0}footer{position:absolute;bottom:14mm;font-size:11px;color:#666}table{border-collapse:collapse;width:100%;font-size:15px;margin:28px 0}td,th{border:1px solid #899b8d;padding:14px 10px;text-align:left}th{background:#eaf0e9}svg{width:100%;margin:20px 0}svg rect{fill:#edf2eb;stroke:#65856a;stroke-width:2}svg text{font:22px sans-serif;text-anchor:middle;fill:#253d2c}svg path{stroke:#476850;stroke-width:4;fill:none}</style>${list.map((p,i)=>`<section class="page"><div class="tag">合成课程 · 虚构教学规则 · 仅用于学习功能验收</div><h1>${p[0]}</h1><h2>${p[1]}</h2>${p.slice(2).map(t=>t.startsWith('<')?t:'<p>'+t+'</p>').join('')}<footer>纸上展览工坊 / ${i+1}</footer></section>`).join('')}</html>`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1250 } });
  for (const [name, content] of [['课程课件', pages], ['追加课件', extra]]) {
    await page.setContent(html(content)); await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: inputs + '/' + name + '.pdf', printBackground: true, preferCSSPageSize: true });
    for (let i=0;i<content.length;i++) await page.locator('.page').nth(i).screenshot({ path: root + '/screenshots/authored-'+name+'-'+(i+1)+'.png' });
  }
} finally { await browser.close(); }
const wav=inputs+'/课程讲解.wav', quoted=s=>s.replaceAll("'","''");
const ps=`$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Speech\n$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry {$v=$s.GetInstalledVoices() | Where-Object {$_.VoiceInfo.Culture.Name -eq 'zh-CN'} | Select-Object -First 1; if(-not $v){throw 'Chinese_voice_missing'}; $s.SelectVoice($v.VoiceInfo.Name); $s.Rate=-1; $s.SetOutputToWaveFile('${quoted(wav)}'); $s.Speak([IO.File]::ReadAllText('${quoted(review+'/合成讲稿.txt')}')); } finally {$s.Dispose()}`;
const speech=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
if(speech.status!==0)throw Error('local_synthesis_failed_'+speech.status);
const probe=spawnSync(ffprobe.path,['-v','error','-show_entries','format=duration:stream=codec_name,sample_rate,channels','-of','json',wav],{windowsHide:true,encoding:'utf8'});
if(probe.status!==0)throw Error('probe_failed'); const audio=JSON.parse(probe.stdout),duration=Number(audio.format.duration);
fs.writeFileSync(review+'/audio-metadata.json',JSON.stringify(audio,null,2));
if(duration<480||duration>600)throw Error('Authoring duration outside 8-10min: '+duration+'; revise before freeze');
for(const [name,at] of [['start',0],['middle',Math.floor(duration/2)],['end',Math.floor(duration-22)]]){
 const r=spawnSync(ffmpeg,['-y','-v','error','-ss',String(at),'-i',wav,'-t','20','-ar','16000','-ac','1',review+'/listen-'+name+'.wav'],{windowsHide:true});if(r.status!==0)throw Error('excerpt_failed');
}
console.log(JSON.stringify({root,pdfPages:[pages.length,extra.length],audioSeconds:duration,characters:script.length,readyForVisualAndListeningReview:true}));
