import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

import { createPublicClient, http } from 'viem';

const execFileAsync = promisify(execFile);
const EXPECTED_ANVIL_VERSION = '1.7.1';
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;

export type OwnedAnvilResult<T> = {
  value: T;
  rpcUrl: string;
  processId: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate a loopback port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export function assertLocalWriteRpcUrl(rpcUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error('write RPC URL must be a valid loopback HTTP URL');
  }

  const isLoopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'http:' ||
    !isLoopback ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('identity demo write operations require a loopback HTTP RPC');
  }
}

async function assertAnvilVersion(binary: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['--version'], {
      timeout: 5_000,
      encoding: 'utf8',
    }));
  } catch (error) {
    throw new Error(
      `Anvil ${EXPECTED_ANVIL_VERSION} is required for the local identity demo; install Foundry, run foundryup --install v${EXPECTED_ANVIL_VERSION}, and ensure anvil is on PATH`,
      { cause: error },
    );
  }

  const match = /^anvil Version: ([^\s]+)/m.exec(stdout);
  if (match?.[1] !== EXPECTED_ANVIL_VERSION) {
    throw new Error(
      `Anvil ${EXPECTED_ANVIL_VERSION} is required for the local identity demo; received ${match?.[1] ?? 'an unknown version'}`,
    );
  }
}

async function waitForReady(child: ChildProcess, rpcUrl: string): Promise<void> {
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: 750 }),
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('owned Anvil process exited before its RPC became ready');
    }
    try {
      const chainId = await client.getChainId();
      if (chainId !== 31_337) {
        throw new Error(`owned Anvil returned unexpected chain ID ${chainId}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw new Error('owned Anvil RPC did not become ready within 10 seconds', {
    cause: lastError,
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return await new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function withOwnedAnvil<T>(
  run: (rpcUrl: string) => Promise<T>,
  options: { anvilBinary?: string } = {},
): Promise<OwnedAnvilResult<T>> {
  const binary = options.anvilBinary ?? 'anvil';
  await assertAnvilVersion(binary);

  const port = await availableLoopbackPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  assertLocalWriteRpcUrl(rpcUrl);

  const child = spawn(
    binary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '31337',
      '--accounts',
      '0',
      '--hardfork',
      'shanghai',
      '--quiet',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const processId = child.pid;
  if (processId === undefined) {
    child.kill('SIGKILL');
    throw new Error('could not start the owned Anvil process');
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      child.kill('SIGKILL');
      await waitForExit(child, STOP_TIMEOUT_MS);
    }
  };

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      removeSignalHandlers();
      void stop().finally(() => process.kill(process.pid, signal));
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    await waitForReady(child, rpcUrl);
    const value = await run(rpcUrl);
    return { value, rpcUrl, processId };
  } finally {
    removeSignalHandlers();
    await stop();
  }
}
