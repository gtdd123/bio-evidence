/**
 * Transport-layer interfaces for the WS-based RPC.
 */

import type { PushTarget } from '@craft-agent/shared/protocol'
import type { Actor } from '@bio-evidence/research-core'
import type { IncomingMessage } from 'node:http'

/** Trusted user-session provider; credentials and claims never come from RPC args. */
export interface UserAuthProvider {
  allowsUpgrade(request: IncomingMessage): boolean
  authenticate(request: IncomingMessage, token?: string): Promise<Actor | null>
  resolveActor(sessionId: string): Actor | null
}
export interface TransportAuthorizationGate {
  allowsChannel(channel: string): boolean
  authorizeRequest(actor: Actor, channel: string, args: unknown[]): void
  authorizeResponse(actor: Actor, channel: string, args: unknown[], result: unknown): void
  allowsEvent(actor: Actor, channel: string, args: unknown[]): boolean
}

export interface RequestContext {
  clientId: string
  workspaceId: string | null
  webContentsId: number | null
  readonly actor?: Actor
}

export type HandlerFn = (ctx: RequestContext, ...args: any[]) => Promise<any> | any

export interface RpcServer {
  handle(channel: string, handler: HandlerFn): void
  push(channel: string, target: PushTarget, ...args: any[]): void
  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any>
  updateClientWorkspace?(clientId: string, workspaceId: string): void

  /** Whether a connected client advertised the given capability on handshake. */
  hasClientCapability(clientId: string, capability: string): boolean

  /** Connected clients (optionally narrowed by workspaceId) that advertised the capability. */
  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[]
}

export interface RpcClient {
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, callback: (...args: any[]) => void): () => void
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void
}

export type EventSink = (channel: string, target: PushTarget, ...args: any[]) => void
