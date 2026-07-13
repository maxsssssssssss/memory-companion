import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { audioFixtureDefinitions, audioFixtureDir, findAudioFixture } from "./lib/audio-fixtures.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const requestedNames = args.filter((arg) => !arg.startsWith("--"));

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function synthesizeWithWindowsSapi({ outputPath, text, rate }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1",
    "if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }",
    `$synth.Rate = ${Number(rate) || 0}`,
    "$synth.Volume = 95",
    `$synth.SetOutputToWaveFile(${quotePowerShell(outputPath)})`,
    `$synth.Speak(${quotePowerShell(text)})`,
    "$synth.Dispose()"
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
}

async function concatWavFiles(inputFiles, outputPath, tempDir) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide an ffmpeg binary path");
  }

  const listPath = path.join(tempDir, "concat.txt");
  const listBody = inputFiles
    .map((filePath) => `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, listBody, "utf8");
  await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
}

async function synthesizeFixture(fixture) {
  await fs.mkdir(audioFixtureDir, { recursive: true });
  const outputExists = await fs
    .access(fixture.filePath)
    .then(() => true)
    .catch(() => false);

  if (outputExists && !force) {
    return { name: fixture.name, filePath: fixture.filePath, status: "skipped" };
  }

  if (process.platform !== "win32") {
    throw new Error("Audio fixture generation currently requires Windows SAPI. Run on Windows or provide fixture WAV files manually.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `daily-brief-fixture-${fixture.name}-`));
  try {
    if (fixture.segments.length === 1) {
      await synthesizeWithWindowsSapi({
        outputPath: fixture.filePath,
        text: fixture.segments[0].text,
        rate: fixture.segments[0].rate
      });
    } else {
      const segmentFiles = [];
      for (const [index, segment] of fixture.segments.entries()) {
        const segmentPath = path.join(tempDir, `segment_${String(index + 1).padStart(2, "0")}.wav`);
        await synthesizeWithWindowsSapi({
          outputPath: segmentPath,
          text: segment.text,
          rate: segment.rate
        });
        segmentFiles.push(segmentPath);
      }
      await concatWavFiles(segmentFiles, fixture.filePath, tempDir);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const stat = await fs.stat(fixture.filePath);
  return { name: fixture.name, filePath: fixture.filePath, status: "written", bytes: stat.size };
}

const selectedFixtures =
  requestedNames.length > 0
    ? requestedNames.map((name) => {
        const fixture = findAudioFixture(name);
        if (!fixture) {
          throw new Error(`Unknown audio fixture: ${name}`);
        }
        return fixture;
      })
    : audioFixtureDefinitions;

const results = [];
for (const fixture of selectedFixtures) {
  results.push(await synthesizeFixture(fixture));
}

console.log(JSON.stringify({ ok: true, force, results }, null, 2));
