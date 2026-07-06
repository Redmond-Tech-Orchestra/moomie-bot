import { createLogger } from '../../logger.js';

const log = createLogger('ChatTurns');

interface ActiveChatTurn {
  id: number;
  startedAt: number;
  interrupt?: () => void | Promise<void>;
}

export interface RegisteredChatTurn {
  setInterrupt(interrupt: () => void | Promise<void>): void;
  finish(): void;
}

let nextId = 1;
let draining = false;
const activeTurns = new Map<number, ActiveChatTurn>();

export function setChatDraining(value: boolean): void {
  if (draining !== value) log.info(value ? 'Entering chat drain mode.' : 'Exiting chat drain mode.');
  draining = value;
}

export function isChatDraining(): boolean {
  return draining;
}

export function registerChatTurn(interrupt?: () => void | Promise<void>): RegisteredChatTurn {
  const id = nextId++;
  const turn: ActiveChatTurn = { id, startedAt: Date.now(), interrupt };
  activeTurns.set(id, turn);
  return {
    setInterrupt(nextInterrupt) {
      turn.interrupt = nextInterrupt;
    },
    finish() {
      activeTurns.delete(id);
    },
  };
}

export function getChatTurnStatus(): { active: number; oldestActiveForMs: number | null; draining: boolean } {
  const oldest = [...activeTurns.values()].reduce<number | null>(
    (min, turn) => min === null || turn.startedAt < min ? turn.startedAt : min,
    null,
  );
  return {
    active: activeTurns.size,
    oldestActiveForMs: oldest === null ? null : Date.now() - oldest,
    draining,
  };
}

export async function interruptActiveChatTurns(reason: string): Promise<void> {
  const turns = [...activeTurns.values()];
  if (turns.length === 0) return;
  log.warn(`Interrupting ${turns.length} active chat turn(s): ${reason}`);
  await Promise.allSettled(turns.map((turn) => turn.interrupt?.()));
}
