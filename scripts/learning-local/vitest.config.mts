import base from "../../vitest.config";

// Current-source acceptance only: historical output snapshots are evidence, not tests.
export default {
  ...base,
  envDir: false,
  test: {
    ...base.test,
    include: [
      "src/lib/server/learning/upload-preparation.test.ts",
      "src/lib/server/learning/pdf-parser-service.test.ts",
      "src/lib/server/learning/audio.test.ts",
      "src/components/learning/learning.test.tsx",
      "src/app/api/learning/pdf-routes.test.ts",
      "src/app/api/learning/audio-routes.test.ts"
    ],
    exclude: ["node_modules/**", "output/**", "test-data/**", ".data/**"]
  }
};
