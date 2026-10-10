import { describe, test, expect } from 'bun:test';
import { RPC_CHANNELS, getAllChannelValues } from '../channels.ts';
import { RESEARCH_CHANNELS, ResearchRequestSchemas, parseResearchRequest, ResearchEventSchema,
  type ResearchRpcChannelMap, type ErrorCode } from '../index.ts';
import { REMOTE_ELIGIBLE_CHANNELS } from '../routing.ts';
import type { BroadcastEventMap } from '../events.ts';

const request: ResearchRpcChannelMap['research:v1:createSession']['args'][0] = {
  scope: { kind: 'personal', ownerId: 'alice' }, name: 'Literature', sourceIds: [],
};
const event: BroadcastEventMap['research:v1:event'][0] = {
  version: 1, id: 'event-a', sequence: 1, scope: request.scope, sessionId: 'session-a',
  resourceId: 'run-a', revision: 1, kind: 'run-changed',
};
const errorCode: ErrorCode = 'BIO_ACCESS_DENIED';
void errorCode;

describe('existing transport research contracts', () => {
  test('has one shared channel declaration and complete remote classification', () => {
    expect(RPC_CHANNELS.research).toBe(RESEARCH_CHANNELS);
    for (const channel of Object.values(RESEARCH_CHANNELS)) {
      expect(getAllChannelValues().filter(value => value === channel)).toHaveLength(1);
      expect(REMOTE_ELIGIBLE_CHANNELS.has(channel)).toBe(true);
    }
  });
  test('every callable research channel has a runtime input validator', () => {
    for (const channel of Object.values(RESEARCH_CHANNELS).filter(value => value !== RESEARCH_CHANNELS.EVENT)) {
      expect(Object.hasOwn(ResearchRequestSchemas, channel)).toBe(true);
    }
    expect(parseResearchRequest(RESEARCH_CHANNELS.CREATE_SESSION, request)).toEqual(request);
  });
  test('strict event contract rejects body/key leakage and protocol drift', () => {
    expect(ResearchEventSchema.safeParse(event).success).toBe(true);
    for (const extra of [{ body: 'synthetic private material' }, { apiKey: 'synthetic' }, { version: 2 }]) {
      expect(ResearchEventSchema.safeParse({ ...event, ...extra }).success).toBe(false);
    }
  });
  test('invalid input error stays generic and excludes injected contents', () => {
    let caught: unknown;
    try { parseResearchRequest(RESEARCH_CHANNELS.CREATE_SESSION, { ...request, secret: 'private-marker' }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain('private-marker');
    expect(String(caught)).not.toContain('secret');
  });
});
