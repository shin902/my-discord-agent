import { exec } from "node:child_process";

export function execAsync(
  command: string,
  options: {
    timeout: number;
    maxBuffer: number;
    cwd: string;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, options, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stdout, stderr });
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
