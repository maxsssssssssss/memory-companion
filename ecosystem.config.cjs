const path = require("node:path");

const logsDirectory = path.join(__dirname, "logs");

module.exports = {
  apps: [
    {
      name: "daily-brief",
      cwd: __dirname,
      script: "npm",
      args: "start",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      kill_timeout: 30_000,
      env: {
        NODE_ENV: "production",
        PIPELINE_EXECUTION_MODE: "queue"
      }
    },
    {
      name: "daily-brief-worker",
      cwd: __dirname,
      script: "npm",
      args: "run worker",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      restart_delay: 5_000,
      kill_timeout: 30 * 60 * 1_000,
      out_file: path.join(logsDirectory, "daily-brief-worker.out.log"),
      error_file: path.join(logsDirectory, "daily-brief-worker.error.log"),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        PIPELINE_EXECUTION_MODE: "queue"
      }
    }
  ]
};
