import { AgentRuntimeRegistry } from './registry.js';
import { RuntimeExecutionBroker } from './agent-broker.js';

export const agentRuntimeRegistry = new AgentRuntimeRegistry();
export const runtimeExecutionBroker = new RuntimeExecutionBroker(agentRuntimeRegistry);
