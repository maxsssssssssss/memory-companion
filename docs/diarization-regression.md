# Diarization Regression

The fixed regression suite covers:

1. single speaker;
2. two speakers;
3. multiple speakers;
4. noise;
5. overlapping speech.

Run the deterministic checked-in fixture:

```powershell
npm run speaker-diarization:regression
```

The default report is:

```text
.data/evaluation/diarization-benchmark.json
```

To evaluate another observed result set:

```powershell
npm run speaker-diarization:regression -- --input path\to\suite.json --output .data\evaluation\custom-diarization-benchmark.json
```

Each case records exact speaker count, boundary recall/error, fragmentation,
and identity match rate. Identity is counted only when the observed segment is
explicitly marked `providerVerified: true`; speaker order, gender, names,
context, and LLM output are never accepted as identity evidence.

Unless a case explicitly overrides them, the deterministic acceptance
thresholds are:

- boundary tolerance: `0.25` seconds;
- minimum boundary recall: `0.80`;
- maximum fragmentation rate: `0.25`;
- minimum Provider-verified identity match rate: `0.90`.

The runner prints one metadata-only progress event for each fixed case, from
`1/5` through `5/5`. The events contain only the case name and PASS/FAIL
result. Reports default to the Git-ignored `.data/evaluation/` directory; keep
all explicit output paths under that directory as well. The runner rejects an
`--output` path outside `.data/evaluation` so it cannot create a tracked report.

The checked-in JSON is a deterministic downstream regression fixture. It does
not contain audio, transcript text, real account IDs, real Provider output, or
Person mappings. It does not call ASR, Voiceprint, Qwen, Redis, or any network
service, and it does not measure real acoustic accuracy.
