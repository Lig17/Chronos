import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface AgentDecision {
  agent: string;
  action: string;
  reasoning: string;
  status: "success" | "failure" | "pending";
  timestamp: string;
}

export interface CrisisScenario {
  type: "flood" | "traffic" | "energy";
  severity: number;
  zone: string;
  isFederated?: boolean;
}

export interface GVUPhase {
  name: "Generator" | "Executor" | "Verifier" | "Updater";
  status: "pending" | "active" | "completed" | "failed";
  reasoning: string;
  details?: any;
}

export interface SimulationResult {
  logs: AgentDecision[];
  phases: GVUPhase[];
}

// --- Message Bus Infrastructure ---
export interface Message {
  id: string;
  topic: string;
  payload: any;
  timestamp: string;
  retries: number;
}

class MessageBus {
  private subscribers: Record<string, ((msg: Message) => Promise<void> | void)[]> = {};
  private queue: Message[] = [];

  constructor() {
    // Load persisted queue for fault tolerance
    const saved = localStorage.getItem('chronos_queue');
    if (saved) this.queue = JSON.parse(saved);
  }

  subscribe(topic: string, callback: (msg: Message) => Promise<void> | void) {
    if (!this.subscribers[topic]) this.subscribers[topic] = [];
    this.subscribers[topic].push(callback);
  }

  async publish(topic: string, payload: any) {
    const message: Message = {
      id: Math.random().toString(36).substr(2, 9),
      topic,
      payload,
      timestamp: new Date().toISOString(),
      retries: 0
    };

    this.queue.push(message);
    this.persist();
    await this.dispatch(message);
  }

  private async dispatch(message: Message) {
    const handlers = this.subscribers[message.topic] || [];
    for (const handler of handlers) {
      await handler(message);
    }
    
    // Remove from active queue once dispatched
    this.queue = this.queue.filter(m => m.id !== message.id);
    this.persist();
  }

  private persist() {
    localStorage.setItem('chronos_queue', JSON.stringify(this.queue));
  }
}

export class Orchestrator {
  private bus = new MessageBus();
  private logs: AgentDecision[] = [];
  private phases: GVUPhase[] = [
    { name: "Generator", status: "pending", reasoning: "Awaiting scenario..." },
    { name: "Executor", status: "pending", reasoning: "Awaiting plan..." },
    { name: "Verifier", status: "pending", reasoning: "Awaiting execution..." },
    { name: "Updater", status: "pending", reasoning: "Awaiting verification..." },
  ];
  private slaThreshold = 10000;
  private onPhaseUpdate?: (phases: GVUPhase[]) => void;
  private onApiStatusChange?: (isWaiting: boolean) => void;

  constructor(onPhaseUpdate?: (phases: GVUPhase[]) => void, onApiStatusChange?: (isWaiting: boolean) => void) {
    this.onPhaseUpdate = onPhaseUpdate;
    this.onApiStatusChange = onApiStatusChange;
    this.setupSubscriptions();
  }

  private setupSubscriptions() {
    // Decoupled Agent Workers
    this.bus.subscribe('tasks', async (msg) => {
      this.updatePhase("Executor", "active", "Processing task queue...");
      const exec = await this.executor(msg.payload.task);
      this.addLog(exec.agent, "Action Executed", exec.reasoning);
      this.bus.publish('executions', { ...exec, scenario: msg.payload.scenario });
    });

    this.bus.subscribe('executions', async (msg) => {
      this.updatePhase("Verifier", "active", "Validating agent output...");
      const validation = await this.validator([msg.payload]);
      this.updatePhase("Verifier", validation.status === "success" ? "completed" : "failed", validation.reasoning);
      this.bus.publish('validation', { validation, scenario: msg.payload.scenario });
    });
  }

  async runScenario(scenario: CrisisScenario): Promise<SimulationResult> {
    const startTime = Date.now();
    this.logs = [];
    this.phases = this.phases.map(p => ({ ...p, status: "pending", reasoning: "Initializing..." }));
    this.onPhaseUpdate?.([...this.phases]);
    
    // 1. Generator Phase
    this.updatePhase("Generator", "active", "Publishing to planning queue...");
    const plan = await this.planner(scenario);
    this.updatePhase("Generator", "completed", plan.reasoning);
    this.addLog("Planner (Generator)", "Neuro-Symbolic Plan Generated", plan.reasoning);

    // 2. Dispatch to Message Bus (Scalable Inter-Agent Communication)
    for (const task of plan.tasks) {
      await this.bus.publish('tasks', { task, scenario });
    }

    // For the demo/UI, we wait for a simulated completion or return current state
    // In a real distributed system, the UI would listen to the bus directly
    await new Promise(r => setTimeout(r, 3000)); 

    return { logs: this.logs, phases: this.phases };
  }

  private updatePhase(name: GVUPhase['name'], status: GVUPhase['status'], reasoning: string) {
    const phase = this.phases.find(p => p.name === name);
    if (phase) {
      phase.status = status;
      phase.reasoning = reasoning;
      this.onPhaseUpdate?.([...this.phases]);
    }
  }

  private addLog(agent: string, action: string, reasoning: string, status: "success" | "failure" | "pending" = "success") {
    this.logs.push({
      agent,
      action,
      reasoning,
      status,
      timestamp: new Date().toISOString()
    });
  }

  private static apiQueue: Promise<any> = Promise.resolve();
  private static lastCallTime = 0;
  private static readonly MIN_CALL_INTERVAL = 5000; // 5s between calls (12 RPM)

  private async callGeminiWithRetry(params: any, retries = 5, delay = 3000): Promise<any> {
    // Chain onto the global queue to ensure absolute sequentiality across all instances
    const result = Orchestrator.apiQueue.then(async () => {
      // Ensure minimum interval between calls
      const now = Date.now();
      const timeSinceLastCall = now - Orchestrator.lastCallTime;
      if (timeSinceLastCall < Orchestrator.MIN_CALL_INTERVAL) {
        this.onApiStatusChange?.(true);
        await new Promise(resolve => setTimeout(resolve, Orchestrator.MIN_CALL_INTERVAL - timeSinceLastCall));
      }
      
      let lastError: any;
      for (let i = 0; i <= retries; i++) {
        try {
          this.onApiStatusChange?.(true);
          Orchestrator.lastCallTime = Date.now();
          const response = await ai.models.generateContent(params);
          this.onApiStatusChange?.(false);
          return response;
        } catch (error: any) {
          lastError = error;
          const errorStr = (error.message || JSON.stringify(error)).toLowerCase();
          const isRateLimit = 
            errorStr.includes("429") || 
            errorStr.includes("resource_exhausted") || 
            errorStr.includes("quota") ||
            error.status === 429 || 
            error.code === 429;

          if (i < retries && isRateLimit) {
            const currentDelay = delay * Math.pow(2, i);
            console.warn(`Rate limit hit (Attempt ${i + 1}/${retries + 1}), retrying in ${currentDelay}ms...`);
            this.onApiStatusChange?.(true);
            await new Promise(resolve => setTimeout(resolve, currentDelay));
            continue;
          }
          this.onApiStatusChange?.(false);
          throw error;
        }
      }
      this.onApiStatusChange?.(false);
      throw lastError;
    });

    // Update the queue to wait for this call (including its retries) to complete
    Orchestrator.apiQueue = result.catch(() => {}); 
    return result;
  }

  private async planner(scenario: CrisisScenario) {
    const prompt = `You are an Urban Crisis Planner. A ${scenario.type} event occurred in Zone ${scenario.zone} with severity ${scenario.severity}/100. 
    ${scenario.isFederated ? "FEDERATED MODE ACTIVE: Coordinate with neighboring zones to prevent cascading failures." : ""}
    Break this down into 3 specific tasks for specialized agents (Traffic, Disaster, Energy).
    CRITICAL: You must ensure the plan adheres to FedFair constraints:
    1. Resource allocation must be equitable across all socioeconomic strata.
    2. Avoid systemic bias in traffic routing that disproportionately impacts low-income zones.
    3. Ensure energy redistribution does not leave vulnerable infrastructure (hospitals, shelters) at risk.
    Return a JSON object with 'tasks' (array of strings) and 'reasoning' (string).`;

    const response = await this.callGeminiWithRetry({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tasks: { type: Type.ARRAY, items: { type: Type.STRING } },
            reasoning: { type: Type.STRING }
          },
          required: ["tasks", "reasoning"]
        }
      }
    });

    return JSON.parse(response.text);
  }

  private async executor(task: string) {
    const prompt = `You are an Urban Crisis Executor. Execute the following task: "${task}".
    Explain your action and reasoning.
    Return a JSON object with 'agent' (which specialized agent you are), 'action' (what you did), and 'reasoning' (why).`;

    const response = await this.callGeminiWithRetry({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            agent: { type: Type.STRING },
            action: { type: Type.STRING },
            reasoning: { type: Type.STRING }
          },
          required: ["agent", "action", "reasoning"]
        }
      }
    });

    return JSON.parse(response.text);
  }

  private async validator(executions: any[]) {
    const prompt = `You are an Urban Crisis Validator. Review these actions: ${JSON.stringify(executions)}.
    Are they sufficient, safe, and EQUITABLE? 
    Evaluate using the following metrics:
    - Atkinson Index (Inequality aversion)
    - Theil Index (Redundancy and entropy)
    - Hoover Index (Redistribution requirement)
    Return a JSON object with 'status' ("success" or "failure"), 'reasoning', and 'fairnessMetrics' (object with atkinson, theil, hoover as numbers between 0 and 1).`;

    const response = await this.callGeminiWithRetry({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            status: { type: Type.STRING, enum: ["success", "failure"] },
            reasoning: { type: Type.STRING },
            fairnessMetrics: {
              type: Type.OBJECT,
              properties: {
                atkinson: { type: Type.NUMBER },
                theil: { type: Type.NUMBER },
                hoover: { type: Type.NUMBER }
              },
              required: ["atkinson", "theil", "hoover"]
            }
          },
          required: ["status", "reasoning", "fairnessMetrics"]
        }
      }
    });

    return JSON.parse(response.text);
  }

  async predict(data: any): Promise<{ scenario: CrisisScenario | null; reasoning: string }> {
    const prompt = `You are an Urban Crisis Monitor Agent. Analyze the following real-time urban data:
    ${JSON.stringify(data)}
    
    Historical context: 
    - Traffic density > 85% usually leads to gridlock within 15 minutes.
    - Rainfall > 4mm/hr with temp < 22C increases flood risk in Zone A.
    - Energy load > 90% predicts grid instability.

    Based on the data, is a crisis IMMINENT (within the next 30 minutes)?
    If yes, specify the scenario (type, severity, zone).
    Return a JSON object with 'scenario' (CrisisScenario or null) and 'reasoning' (string).`;

    const response = await this.callGeminiWithRetry({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scenario: {
              type: Type.OBJECT,
              nullable: true,
              properties: {
                type: { type: Type.STRING, enum: ["flood", "traffic", "energy"] },
                severity: { type: Type.NUMBER },
                zone: { type: Type.STRING }
              },
              required: ["type", "severity", "zone"]
            },
            reasoning: { type: Type.STRING }
          },
          required: ["scenario", "reasoning"]
        }
      }
    });

    return JSON.parse(response.text);
  }
}
