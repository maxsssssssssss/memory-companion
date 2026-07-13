import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const audioFixtureDir = path.join(repoRoot, "fixtures", "audio");

export const audioFixtureDefinitions = [
  {
    name: "non_relationship_60s",
    fileName: "non_relationship_60s.wav",
    expectedContext: "non_relationship",
    expectedRelationshipSignals: 0,
    description: "Technical integration discussion. Relationship Signal Cards should stay empty.",
    segments: [
      {
        speaker: "narrator",
        rate: -1,
        text:
          "今天我们做本地工程联调。第一步，检查 Next 服务是否监听三二零零端口。第二步，确认上传接口能够接收音频文件。第三步，查看任务轮询结果、接口状态、错误日志和前端页面。随后我们继续检查模型调用、数据结构、缓存文件和测试报告。这段内容只讨论软件开发、服务配置、接口验证、页面渲染和日志排查，不涉及私人生活判断，也不涉及任何两个人相处的评价。最后我们记录命令、状态码、返回字段和后续修复点。"
      }
    ]
  },
  {
    name: "relationship_dialogue_90s",
    fileName: "relationship_dialogue_90s.wav",
    expectedContext: "relationship",
    expectedRelationshipSignals: "some",
    description: "A privacy-safe simulated dating conversation with listening, boundary, and commitment evidence.",
    segments: [
      {
        speaker: "speaker_a",
        rate: -1,
        text:
          "甲说，我想问问你下周还想见面吗？上次你突然很久没有回消息，我有一点不安。"
      },
      {
        speaker: "speaker_b",
        rate: 0,
        text:
          "乙说，我听到了，你会不安，是因为不知道我是不是认真，对吗？这个感受我可以理解。"
      },
      {
        speaker: "speaker_a",
        rate: -1,
        text:
          "甲说，是的，我希望我们能提前说清楚。如果临时忙，也告诉我一声。"
      },
      {
        speaker: "speaker_b",
        rate: 0,
        text:
          "乙说，这个要求可以理解。下次如果我临时有事，我会提前发消息。"
      },
      {
        speaker: "speaker_a",
        rate: -1,
        text:
          "甲说，谢谢你愿意这样说。我也想表达一个边界，如果我说今晚需要自己休息，希望你不要一直追问。"
      },
      {
        speaker: "speaker_b",
        rate: 0,
        text:
          "乙说，可以，我尊重你需要休息。至于下周见面，我现在还不能完全确定周五是否有工作安排，但我周三前给你明确答复。"
      },
      {
        speaker: "speaker_a",
        rate: -1,
        text: "甲说，好，这样我会安心很多。"
      }
    ]
  },
  {
    name: "two_speaker_relationship",
    fileName: "two_speaker_relationship.wav",
    expectedContext: "relationship",
    expectedRelationshipSignals: "some",
    description: "A synthetic two-role relationship dialogue for diarization smoke tests. It is not private data.",
    segments: [
      {
        speaker: "speaker_a",
        rate: -2,
        text:
          "甲说，昨天我说不想太晚见面，是因为第二天早上还有事情，不是故意冷淡。"
      },
      {
        speaker: "speaker_b",
        rate: 1,
        text:
          "乙说，我明白了。谢谢你解释清楚。你说需要早点休息，我以后会提前问你的时间。"
      },
      {
        speaker: "speaker_a",
        rate: -2,
        text:
          "甲说，我也想知道你是不是还愿意继续了解我。如果你不确定，也可以直接说。"
      },
      {
        speaker: "speaker_b",
        rate: 1,
        text:
          "乙说，我愿意继续了解你。只是这周工作安排还没定，我周四晚上给你明确答复。"
      },
      {
        speaker: "speaker_a",
        rate: -2,
        text: "甲说，好的，有明确时间我就不会一直猜了。"
      }
    ]
  }
].map((fixture) => ({
  ...fixture,
  filePath: path.join(audioFixtureDir, fixture.fileName)
}));

export function findAudioFixture(name) {
  return audioFixtureDefinitions.find((fixture) => fixture.name === name) ?? null;
}
