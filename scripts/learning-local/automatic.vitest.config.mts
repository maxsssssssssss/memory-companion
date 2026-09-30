import base from "../../vitest.config";

// Learning-only integration, current sources; never scan saved historical outputs.
export default {
  ...base,
  envDir: false,
  test: {
    ...base.test,
    include: ["src/lib/server/learning/**/*.test.ts", "src/components/learning/**/*.test.tsx", "src/app/api/learning/**/*.test.ts"],
    exclude: ["node_modules/**", "output/**", "test-data/**", ".data/**"],
    maxWorkers: 2
  }
};
