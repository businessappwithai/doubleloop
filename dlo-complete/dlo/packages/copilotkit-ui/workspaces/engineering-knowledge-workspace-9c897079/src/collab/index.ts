// src/collab/index.ts — public surface of the Yjs collaboration client module.
export {
  createCollabProvider,
  type CollabProvider,
  type CollabStatus,
  type CollabTimer,
  type CollabTimerHandle,
  type CreateCollabProviderOptions,
  type WebSocketPolyfillCtor,
} from "./provider";
export {
  setLocalPresence,
  subscribePresence,
  computePresence,
  colorForActor,
  STALE_PEER_THRESHOLD_MS,
  type LocalPresence,
  type PresencePeer,
  type PresenceClock,
  type ComputePresenceOptions,
  type SubscribePresenceOptions,
} from "./awareness";
export {
  CollaborationPluginBridge,
  isRoomEmpty,
  type CollaborationPluginBridgeProps,
} from "./CollaborationPluginBridge";
export { PresenceBar, type PresenceBarProps } from "./PresenceBar";
