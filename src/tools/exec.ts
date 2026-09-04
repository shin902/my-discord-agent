import { exec, spawn } from "node:child_process";

export type ExecOptions = {
  timeout: number;
  maxBuffer: number;
  cwd: string;
  signal?: AbortSignal;
  /** Run the shell and its descendants in a call-scoped Unix process group. */
  processGroup?: boolean;
};

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function commandFailure(command: string): Error {
  return new Error(`Command failed: ${command}`);
}

/**
 * Execute a command while retaining the old exec implementation by default.
 * agent-reach opts into process groups because its runtime outlives individual
 * agent containers and must not leave yt-dlp/python descendants behind.
 */
export function execAsync(
  command: string,
  options: ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (!options.processGroup) {
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

  if (process.platform === "win32") {
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

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationRequested = false;
    let terminationError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        // The group can disappear between the close event and escalation. If
        // another process changed the group, still try to terminate the direct
        // child without allowing an abort handler to throw uncaught.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {
            // The child may have exited concurrently.
          }
        }
      }
    };

    const requestTermination = (error: Error): void => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationError = error;
      killGroup("SIGTERM");
      // A child may ignore SIGTERM. Keep the call pending until this bounded
      // escalation has happened, so resolving cannot expose a live descendant.
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        killTimer = undefined;
        maybeSettle();
      }, 250);
      killTimer.unref();
      maybeSettle();
    };

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const maybeSettle = (): void => {
      if (settled || (child.exitCode === null && child.signalCode === null))
        return;
      if (terminationRequested && killTimer) return;
      settled = true;
      cleanup();
      const error = terminationError;
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else if (child.signalCode !== null || child.exitCode !== 0) {
        const failure = commandFailure(command) as Error & {
          code?: number;
          signal?: NodeJS.Signals;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        failure.code = child.exitCode ?? undefined;
        failure.signal = child.signalCode ?? undefined;
        failure.killed = child.signalCode !== null;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      } else {
        resolve({ stdout, stderr });
      }
    };

    const onAbort = (): void => requestTermination(abortError());
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdout += chunk;
      if (stdoutBytes > options.maxBuffer && !terminationRequested) {
        requestTermination(new Error("stdout maxBuffer length exceeded"));
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderr += chunk;
      if (stderrBytes > options.maxBuffer && !terminationRequested) {
        requestTermination(new Error("stderr maxBuffer length exceeded"));
      }
    });
    child.once("error", (error) => {
      if (!terminationRequested) {
        terminationRequested = true;
        terminationError = error;
      }
      maybeSettle();
    });
    child.once("close", maybeSettle);

    timeoutTimer = setTimeout(() => {
      const error = commandFailure(command) as Error & {
        killed?: boolean;
        signal?: NodeJS.Signals;
      };
      error.killed = true;
      error.signal = "SIGTERM";
      requestTermination(error);
    }, options.timeout);
    timeoutTimer.unref();
  });
}
