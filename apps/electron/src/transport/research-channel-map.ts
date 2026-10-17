import { ResearchRequestSchemas, RESEARCH_CHANNELS } from '@bio-evidence/research-core'
import type { ChannelMap } from './build-api'
export const RESEARCH_CHANNEL_MAP: ChannelMap = {
  ...Object.fromEntries(Object.keys(ResearchRequestSchemas).map(channel => [`research.${channel.slice('research:v1:'.length)}`, { type: 'invoke' as const, channel }])),
  'research.onEvent': { type: 'listener', channel: RESEARCH_CHANNELS.EVENT },
}
