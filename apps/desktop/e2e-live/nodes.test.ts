import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";

const forced: number[] = []; // ports the next `listen(0)` calls get instead of an OS pick

vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof import("node:net")>();
  const createServer = ((...args: Parameters<typeof net.createServer>) => {
    const server = net.createServer(...args);
    const listen = server.listen.bind(server) as (...a: unknown[]) => typeof server;
    server.listen = ((port: unknown, ...rest: unknown[]) =>
      listen(port === 0 && forced.length ? forced.shift() : port, ...rest)) as typeof server.listen;
    return server;
  }) as typeof net.createServer;
  return { ...net, createServer, default: { ...net, createServer } };
});

const opened: { closed: boolean }[] = []; // every UDP socket freePorts creates, and whether it was closed

vi.mock("node:dgram", async (importOriginal) => {
  const dgram = await importOriginal<typeof import("node:dgram")>();
  const createSocket = ((...args: Parameters<typeof dgram.createSocket>) => {
    const socket = dgram.createSocket(...args);
    const entry = { closed: false };
    opened.push(entry);
    socket.once("close", () => (entry.closed = true));
    return socket;
  }) as typeof dgram.createSocket;
  return { ...dgram, createSocket, default: { ...dgram, createSocket } };
});

const { freePorts } = await import("./nodes");

function bindUdp(port = 0): Promise<Socket> {
  const socket = createSocket("udp4");
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => resolve(socket));
  });
}

describe("freePorts", () => {
  const held: Socket[] = [];
  afterEach(() => {
    forced.length = 0;
    for (const socket of held.splice(0)) socket.close();
  });

  it("skips a port whose UDP side is taken, since a swarm port also listens on QUIC", async () => {
    const taken = await bindUdp();
    held.push(taken);
    forced.push(taken.address().port);

    opened.length = 0;
    const [port] = await freePorts(1);

    expect(port).not.toBe(taken.address().port);
    expect(opened.filter((s) => !s.closed)).toHaveLength(0); // the failed bind's socket too
    held.push(await bindUdp(port));
  });
});
