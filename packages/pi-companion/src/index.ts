export {
  companionEnqueue,
  companionJobCreate,
  companionJobList,
  companionStatus,
  daemonAvailable,
  socketPath,
  type CompanionError,
  type CompanionResult,
} from "./client.js";
export { default as gatewayCompanion, resolveProfileDir, type CompanionHost } from "./extension.js";
