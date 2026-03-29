import { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  AlertTriangle, 
  ShieldCheck, 
  Zap, 
  Map as MapIcon, 
  BarChart3, 
  History,
  Play,
  RefreshCcw,
  RefreshCw,
  Settings2,
  ChevronRight,
  Info
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { MapContainer, TileLayer, Circle, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Toaster, toast } from 'sonner';
import { Orchestrator, AgentDecision, CrisisScenario, GVUPhase } from './agents/orchestrator';
import { cn } from './lib/utils';

// --- Types ---
interface UrbanData {
  traffic: { zone: string; density: number; status: string }[];
  weather: { temp: number; rainfall: number; condition: string };
  energy: { load: number; capacity: number };
}

// --- Components ---

const StatCard = ({ title, value, icon: Icon, color, trend }: any) => (
  <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 p-5 rounded-3xl shadow-2xl hover:bg-white/[0.05] transition-all group">
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center space-x-2">
        <div className={cn("p-2 rounded-lg bg-opacity-10", color.replace('text-', 'bg-'))}>
          <Icon className={cn("w-4 h-4", color)} />
        </div>
        <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/40">{title}</span>
      </div>
      {trend && (
        <span className={cn("text-[10px] font-mono", trend > 0 ? "text-green-400" : "text-red-400")}>
          {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
        </span>
      )}
    </div>
    <div className="text-3xl font-bold text-white tracking-tight group-hover:text-orange-500 transition-colors">{value}</div>
  </div>
);

const MapUpdater = ({ center }: { center: [number, number] }) => {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 13);
  }, [center, map]);
  return null;
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'analytics' | 'logs'>('dashboard');
  const [urbanData, setUrbanData] = useState<UrbanData | null>(null);
  const [logs, setLogs] = useState<AgentDecision[]>([]);
  const [gvuPhases, setGvuPhases] = useState<GVUPhase[]>([
    { name: "Generator", status: "pending", reasoning: "Awaiting scenario..." },
    { name: "Executor", status: "pending", reasoning: "Awaiting plan..." },
    { name: "Verifier", status: "pending", reasoning: "Awaiting execution..." },
    { name: "Updater", status: "pending", reasoning: "Awaiting verification..." },
  ]);
  const [isSimulating, setIsSimulating] = useState(false);
  const [severity, setSeverity] = useState(50);
  const [selectedZone, setSelectedZone] = useState('A');
  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]);
  const [demoMode, setDemoMode] = useState(false);
  const [prediction, setPrediction] = useState<{ scenario: CrisisScenario | null; reasoning: string } | null>(null);
  const [isPredicting, setIsPredicting] = useState(false);
  const [isApiWaiting, setIsApiWaiting] = useState(false);
  const [autoPredict, setAutoPredict] = useState(true);
  const [isFederatedMode, setIsFederatedMode] = useState(false);
  const lastPredictionTime = useRef<number>(0);

  const zones: Record<string, [number, number]> = {
    'A': [51.505, -0.09],
    'B': [51.515, -0.1],
    'C': [51.495, -0.08],
  };

  const triggerScenario = async (type: CrisisScenario['type']) => {
    if (isSimulating || isPredicting) return;
    setIsSimulating(true);
    setMapCenter(zones[selectedZone]);
    const orchestrator = new Orchestrator(
      (phases) => setGvuPhases([...phases]),
      (isWaiting) => setIsApiWaiting(isWaiting)
    );
    try {
      if (isFederatedMode) {
        setLogs(prev => [{
          agent: "Federated Coordinator",
          action: "Initiating Cross-Zone Sync",
          reasoning: "Federated mode active. Synchronizing state across Zones A, B, and C to prevent cascading failures.",
          status: "success",
          timestamp: new Date().toISOString()
        }, ...prev]);
        
        // Run federated scenarios sequentially to avoid hitting rate limits
        const results = [];
        for (const z of Object.keys(zones)) {
          const res = await orchestrator.runScenario({ type, severity, zone: z, isFederated: true });
          results.push(res);
        }
        
        results.forEach(result => {
          setLogs(prev => [...result.logs, ...prev]);
        });
      } else {
        const result = await orchestrator.runScenario({ type, severity, zone: selectedZone, isFederated: false });
        setLogs(prev => [...result.logs, ...prev]);
      }
    } catch (error: any) {
      console.error("Simulation failed", error);
      const errorStr = (error.message || JSON.stringify(error)).toLowerCase();
      if (errorStr.includes("quota") || errorStr.includes("429")) {
        toast.error("Simulation Failed: API Quota", {
          description: "The Gemini API is currently unavailable due to rate limits.",
        });
      }
    } finally {
      setIsSimulating(false);
    }
  };

  useEffect(() => {
    fetch('/api/urban-data')
      .then(res => res.json())
      .then(setUrbanData);
    
    const interval = setInterval(() => {
      fetch('/api/urban-data')
        .then(res => res.json())
        .then(setUrbanData);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let demoInterval: any;
    if (demoMode) {
      const scenarios: CrisisScenario['type'][] = ['flood', 'traffic', 'energy'];
      let index = 0;
      demoInterval = setInterval(() => {
        if (!isSimulating && !isPredicting) {
          triggerScenario(scenarios[index % scenarios.length]);
          index++;
        }
      }, 120000);
    }
    return () => clearInterval(demoInterval);
  }, [demoMode, isSimulating]);

  const runPrediction = async (force = false) => {
    const now = Date.now();
    if (urbanData && !isSimulating && !isPredicting && (force || now - lastPredictionTime.current > 60000)) {
      const orchestrator = new Orchestrator(undefined, (isWaiting) => setIsApiWaiting(isWaiting));
      setIsPredicting(true);
      lastPredictionTime.current = now;
      try {
        const res = await orchestrator.predict(urbanData);
        setPrediction(res);
        if (res.scenario && !isSimulating) {
          setSelectedZone(res.scenario.zone);
          setSeverity(res.scenario.severity);
          triggerScenario(res.scenario.type);
        }
      } catch (err: any) {
        console.error("Prediction failed", err);
        const errorStr = (err.message || JSON.stringify(err)).toLowerCase();
        if (errorStr.includes("quota") || errorStr.includes("429")) {
          toast.error("Gemini API Quota Exceeded", {
            description: "The system is currently rate-limited. Auto-prediction paused.",
          });
          setAutoPredict(false);
        }
      } finally {
        setIsPredicting(false);
      }
    }
  };

  useEffect(() => {
    if (autoPredict) {
      runPrediction();
    }
  }, [urbanData, autoPredict]);

  const chartData = [
    { time: '10:00', response: 45, efficiency: 60 },
    { time: '11:00', response: 40, efficiency: 65 },
    { time: '12:00', response: 35, efficiency: 75 },
    { time: '13:00', response: 30, efficiency: 85 },
    { time: '14:00', response: 25, efficiency: 92 },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      <Toaster position="top-right" theme="dark" />
      {/* Sidebar Navigation */}
      <nav className="fixed left-0 top-0 h-full w-20 border-r border-white/10 flex flex-col items-center py-8 space-y-8 bg-black/40 backdrop-blur-xl z-50">
        <div className="w-12 h-12 bg-orange-600 rounded-xl flex items-center justify-center shadow-lg shadow-orange-600/20">
          <Activity className="text-white" />
        </div>
        <div className="flex flex-col space-y-6">
          <button onClick={() => setActiveTab('dashboard')} className={cn("p-3 rounded-xl transition-all", activeTab === 'dashboard' ? "bg-white/10 text-orange-500" : "text-white/40 hover:text-white")}>
            <MapIcon size={24} />
          </button>
          <button onClick={() => setActiveTab('analytics')} className={cn("p-3 rounded-xl transition-all", activeTab === 'analytics' ? "bg-white/10 text-orange-500" : "text-white/40 hover:text-white")}>
            <BarChart3 size={24} />
          </button>
          <button onClick={() => setActiveTab('logs')} className={cn("p-3 rounded-xl transition-all", activeTab === 'logs' ? "bg-white/10 text-orange-500" : "text-white/40 hover:text-white")}>
            <History size={24} />
          </button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pl-20 min-h-screen">
        <header className="h-20 border-b border-white/10 flex items-center justify-between px-8 bg-black/20 backdrop-blur-md sticky top-0 z-40">
          <div>
            <h1 className="text-xl font-bold tracking-tight">CHRONOS-GRAPH <span className="text-orange-500">ORCHESTRATOR</span></h1>
            <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em]">Autonomous Multi-Agent Crisis Management</p>
          </div>
          <div className="flex items-center space-x-4">
            <button 
              onClick={() => setDemoMode(!demoMode)}
              className={cn(
                "flex items-center space-x-2 px-4 py-2 rounded-full border transition-all text-[10px] font-bold uppercase tracking-widest",
                demoMode ? "bg-orange-500 border-orange-400 text-white animate-pulse" : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
              )}
            >
              <RefreshCcw size={14} className={demoMode ? "animate-spin" : ""} />
              <span>{demoMode ? "Demo Mode Active" : "Start Auto-Demo"}</span>
            </button>
            <div className="flex items-center space-x-2 bg-green-500/10 px-3 py-1 rounded-full border border-green-500/20">
              <div className={cn("w-2 h-2 rounded-full animate-pulse", isApiWaiting ? "bg-yellow-500" : isPredicting ? "bg-blue-500" : "bg-green-500")} />
              <span className={cn("text-[10px] font-bold uppercase", isApiWaiting ? "text-yellow-500" : isPredicting ? "text-blue-500" : "text-green-500")}>
                {isApiWaiting ? "API Rate Limit Wait" : isPredicting ? "Predicting..." : "Monitor Active"}
              </span>
            </div>
            <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
              <Settings2 size={18} className="text-white/60" />
            </div>
          </div>
        </header>

        <div className="p-8">
          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="grid grid-cols-12 gap-8"
              >
                {/* Stats Row */}
                <div className="col-span-12 grid grid-cols-4 gap-6">
                  <StatCard title="Atkinson Index" value="0.14" icon={ShieldCheck} color="text-green-400" trend={-0.02} />
                  <StatCard title="Theil Index" value="0.08" icon={Zap} color="text-blue-400" />
                  <StatCard title="Hoover Index" value="0.11" icon={Activity} color="text-orange-400" />
                  <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 p-5 rounded-3xl shadow-2xl relative overflow-hidden group">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center space-x-2">
                        <div className="p-2 rounded-lg bg-blue-500/10">
                          <Activity className="w-4 h-4 text-blue-400" />
                        </div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/40">Predictive Monitor</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button 
                          onClick={() => setAutoPredict(!autoPredict)}
                          className={cn(
                            "p-1.5 rounded-lg border transition-all",
                            autoPredict ? "bg-blue-500/10 border-blue-500/20 text-blue-400" : "bg-white/5 border-white/10 text-white/20"
                          )}
                          title={autoPredict ? "Auto-predict ON" : "Auto-predict OFF"}
                        >
                          <RefreshCcw size={12} className={autoPredict && isPredicting ? "animate-spin" : ""} />
                        </button>
                        <button 
                          onClick={() => runPrediction(true)}
                          disabled={isPredicting || isApiWaiting}
                          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all disabled:opacity-50"
                          title="Run manual prediction"
                        >
                          <RefreshCw size={12} className={!autoPredict && isPredicting ? "animate-spin" : ""} />
                        </button>
                      </div>
                    </div>
                    <div className="text-[11px] text-white/80 leading-tight line-clamp-2 italic">
                      {prediction?.reasoning || (isPredicting ? "Analyzing urban patterns..." : "Standby...")}
                    </div>
                    {prediction?.scenario && (
                      <div className="absolute top-2 right-2">
                        <div className="w-2 h-2 bg-red-500 rounded-full animate-ping" />
                      </div>
                    )}
                  </div>
                </div>

                {/* Map Section */}
                <div className="col-span-8 space-y-8">
                  <div className="h-[500px] bg-white/5 rounded-3xl border border-white/10 overflow-hidden relative shadow-2xl">
                    <MapContainer center={mapCenter} zoom={13} style={{ height: '100%', width: '100%', background: '#111' }}>
                      <TileLayer
                        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                      />
                      <MapUpdater center={mapCenter} />
                      {Object.entries(zones).map(([name, pos]) => (
                        <Circle 
                          key={name}
                          center={pos} 
                          radius={1000}
                          pathOptions={{ 
                            color: (isFederatedMode || name === selectedZone) ? '#f97316' : '#3b82f6',
                            fillColor: (isFederatedMode || name === selectedZone) ? '#f97316' : '#3b82f6',
                            fillOpacity: (isFederatedMode || name === selectedZone) ? 0.3 : 0.1
                          }}
                        >
                          <Popup>Zone {name}</Popup>
                        </Circle>
                      ))}
                    </MapContainer>
                    <div className="absolute top-4 right-4 z-[1000] flex flex-col space-y-2">
                      {['A', 'B', 'C'].map(z => (
                        <button 
                          key={z}
                          onClick={() => setSelectedZone(z)}
                          className={cn(
                            "px-4 py-2 rounded-lg font-mono text-xs transition-all border",
                            selectedZone === z ? "bg-orange-500 border-orange-400 text-white" : "bg-black/60 border-white/10 text-white/60 hover:bg-black/80"
                          )}
                        >
                          ZONE {z}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* GVU Reasoning Flow Diagram */}
                  <div className="bg-white/5 rounded-3xl border border-white/10 p-8 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-orange-500/20 to-transparent" />
                    
                    <h3 className="text-sm font-mono uppercase tracking-widest text-white/60 mb-10 flex items-center">
                      <RefreshCcw className="w-4 h-4 mr-2 text-orange-500" />
                      Neuro-Symbolic GVU Reasoning Pipeline
                    </h3>
                    
                    <div className="grid grid-cols-4 gap-6 relative">
                      {/* Animated Connection Lines */}
                      <div className="absolute top-1/2 left-0 w-full h-px bg-white/5 -translate-y-1/2 -z-10" />
                      
                      {gvuPhases.map((phase, i) => (
                        <div key={phase.name} className="relative">
                          {/* Flow Arrow */}
                          {i < gvuPhases.length - 1 && (
                            <div className="absolute top-1/2 -right-4 -translate-y-1/2 z-20">
                              <ChevronRight 
                                size={16} 
                                className={cn(
                                  "transition-colors duration-500",
                                  gvuPhases[i].status === 'completed' ? "text-green-500" : "text-white/10"
                                )} 
                              />
                            </div>
                          )}

                          <motion.div 
                            initial={false}
                            animate={{ 
                              scale: phase.status === 'active' ? 1.05 : 1,
                              opacity: phase.status === 'pending' ? 0.3 : 1,
                              borderColor: phase.status === 'active' ? 'rgba(249, 115, 22, 1)' : 
                                         phase.status === 'completed' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255, 255, 255, 0.1)'
                            }}
                            className={cn(
                              "relative p-5 rounded-2xl border bg-black/40 backdrop-blur-md transition-all duration-500 flex flex-col items-center text-center h-full",
                              phase.status === 'active' && "shadow-[0_0_30px_rgba(249,115,22,0.15)]"
                            )}
                          >
                            {/* Status Pulse */}
                            {phase.status === 'active' && (
                              <div className="absolute -top-1 -right-1 w-3 h-3">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-3 w-3 bg-orange-500"></span>
                              </div>
                            )}

                            <div className={cn(
                              "w-12 h-12 rounded-2xl flex items-center justify-center mb-4 transition-colors duration-500",
                              phase.status === 'active' ? "bg-orange-500 text-white" : 
                              phase.status === 'completed' ? "bg-green-500/20 text-green-500" :
                              "bg-white/5 text-white/20"
                            )}>
                              {i === 0 && <Settings2 size={22} />}
                              {i === 1 && <Play size={22} />}
                              {i === 2 && <ShieldCheck size={22} />}
                              {i === 3 && <RefreshCcw size={22} />}
                            </div>
                            
                            <h4 className={cn(
                              "text-[10px] font-bold uppercase tracking-[0.2em] mb-3",
                              phase.status === 'active' ? "text-orange-500" : "text-white/60"
                            )}>
                              {phase.name}
                            </h4>
                            
                            <div className="flex-1 flex items-center justify-center">
                              <p className="text-[10px] text-white/40 leading-relaxed italic font-mono">
                                {phase.reasoning}
                              </p>
                            </div>

                            {/* Progress Bar */}
                            <div className="absolute bottom-0 left-0 w-full h-1 bg-white/5 rounded-b-2xl overflow-hidden">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ 
                                  width: phase.status === 'completed' ? '100%' : 
                                         phase.status === 'active' ? '60%' : '0%' 
                                }}
                                className={cn(
                                  "h-full transition-all duration-1000",
                                  phase.status === 'completed' ? "bg-green-500" : "bg-orange-500"
                                )}
                              />
                            </div>
                          </motion.div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Controls & Alerts */}
                <div className="col-span-4 space-y-8">
                  <div className="bg-white/5 rounded-3xl border border-white/10 p-6 space-y-6">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-mono uppercase tracking-widest text-white/60">Simulation Controls</h3>
                      <div className="flex items-center space-x-2">
                        <span className="text-[10px] font-mono text-white/40 uppercase">Federated</span>
                        <button 
                          onClick={() => setIsFederatedMode(!isFederatedMode)}
                          className={cn(
                            "w-10 h-5 rounded-full relative transition-colors",
                            isFederatedMode ? "bg-orange-500" : "bg-white/10"
                          )}
                        >
                          <motion.div 
                            animate={{ x: isFederatedMode ? 22 : 2 }}
                            className="absolute top-1 left-0 w-3 h-3 bg-white rounded-full shadow-sm"
                          />
                        </button>
                      </div>
                    </div>
                    
                    <div className="space-y-4">
                      <label className="text-[10px] font-mono uppercase text-white/40 block">Crisis Severity: {severity}%</label>
                      <input 
                        type="range" 
                        min="1" 
                        max="100" 
                        value={severity} 
                        onChange={(e) => setSeverity(parseInt(e.target.value))}
                        className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-orange-500"
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      <button 
                        disabled={isSimulating}
                        onClick={() => triggerScenario('flood')}
                        className="flex items-center justify-between p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl hover:bg-blue-500/20 transition-all group"
                      >
                        <div className="flex items-center">
                          <AlertTriangle className="text-blue-400 mr-3" size={20} />
                          <div className="text-left">
                            <div className="text-sm font-bold">Flood Event</div>
                            <div className="text-[10px] text-white/40">Zone {selectedZone} Risk Analysis</div>
                          </div>
                        </div>
                        <Play size={16} className="text-blue-400 group-hover:translate-x-1 transition-transform" />
                      </button>

                      <button 
                        disabled={isSimulating}
                        onClick={() => triggerScenario('traffic')}
                        className="flex items-center justify-between p-4 bg-orange-500/10 border border-orange-500/20 rounded-2xl hover:bg-orange-500/20 transition-all group"
                      >
                        <div className="flex items-center">
                          <Activity className="text-orange-400 mr-3" size={20} />
                          <div className="text-left">
                            <div className="text-sm font-bold">Traffic Spike</div>
                            <div className="text-[10px] text-white/40">Congestion Mitigation</div>
                          </div>
                        </div>
                        <Play size={16} className="text-orange-400 group-hover:translate-x-1 transition-transform" />
                      </button>

                      <button 
                        disabled={isSimulating}
                        onClick={() => triggerScenario('energy')}
                        className="flex items-center justify-between p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-2xl hover:bg-yellow-500/20 transition-all group"
                      >
                        <div className="flex items-center">
                          <Zap className="text-yellow-400 mr-3" size={20} />
                          <div className="text-left">
                            <div className="text-sm font-bold">Grid Overload</div>
                            <div className="text-[10px] text-white/40">Energy Redistribution</div>
                          </div>
                        </div>
                        <Play size={16} className="text-yellow-400 group-hover:translate-x-1 transition-transform" />
                      </button>
                    </div>
                  </div>

                  <div className="bg-white/5 rounded-3xl border border-white/10 p-6 h-[340px] flex flex-col">
                    <h3 className="text-sm font-mono uppercase tracking-widest text-white/60 mb-4">Real-time Alerts</h3>
                    <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                      {logs.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-white/20">
                          <ShieldCheck size={48} className="mb-2 opacity-20" />
                          <p className="text-xs font-mono">No active alerts</p>
                        </div>
                      )}
                      {logs.map((log, i) => (
                        <motion.div 
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          key={i} 
                          className="p-3 bg-white/5 border border-white/10 rounded-xl"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-bold text-orange-500 uppercase">{log.agent}</span>
                            <span className="text-[8px] text-white/40 font-mono">{new Date(log.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <p className="text-[11px] text-white/80 leading-relaxed">{log.action}</p>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'analytics' && (
              <motion.div 
                key="analytics"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="space-y-8"
              >
                <div className="grid grid-cols-3 gap-8">
                  <div className="col-span-2 bg-white/5 rounded-3xl border border-white/10 p-8">
                    <h3 className="text-lg font-bold mb-8">System Efficiency Over Time</h3>
                    <div className="h-[400px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData}>
                          <defs>
                            <linearGradient id="colorEff" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#f97316" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="#f97316" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                          <XAxis dataKey="time" stroke="#ffffff40" fontSize={12} tickLine={false} axisLine={false} />
                          <YAxis stroke="#ffffff40" fontSize={12} tickLine={false} axisLine={false} />
                          <Tooltip 
                            contentStyle={{ backgroundColor: '#111', border: '1px solid #ffffff20', borderRadius: '12px' }}
                            itemStyle={{ color: '#f97316' }}
                          />
                          <Area type="monotone" dataKey="efficiency" stroke="#f97316" strokeWidth={3} fillOpacity={1} fill="url(#colorEff)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="bg-white/5 rounded-3xl border border-white/10 p-8 flex flex-col justify-between">
                    <div>
                      <h3 className="text-lg font-bold mb-2">Impact Summary</h3>
                      <p className="text-sm text-white/40">Estimated gains with AI orchestration</p>
                    </div>
                    <div className="space-y-6">
                      <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-2xl">
                        <div className="text-2xl font-bold text-green-500">0.96</div>
                        <div className="text-[10px] font-mono uppercase text-white/60">Jain's Fairness Index</div>
                      </div>
                      <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl">
                        <div className="text-2xl font-bold text-blue-500">12ms</div>
                        <div className="text-[10px] font-mono uppercase text-white/60">Multi-Hop Reasoning Latency</div>
                      </div>
                      <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-2xl">
                        <div className="text-2xl font-bold text-orange-500">88%</div>
                        <div className="text-[10px] font-mono uppercase text-white/60">Hallucination Reduction</div>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'logs' && (
              <motion.div 
                key="logs"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="bg-white/5 rounded-3xl border border-white/10 overflow-hidden"
              >
                <div className="p-6 border-b border-white/10 flex justify-between items-center">
                  <h3 className="text-lg font-bold">Audit Trail & Decision Logs</h3>
                  <button onClick={() => setLogs([])} className="text-[10px] font-mono uppercase text-white/40 hover:text-white transition-colors">Clear Logs</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-white/5 text-[10px] font-mono uppercase text-white/40">
                        <th className="p-6">Timestamp</th>
                        <th className="p-6">Agent</th>
                        <th className="p-6">Action</th>
                        <th className="p-6">Reasoning</th>
                        <th className="p-6">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log, i) => (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                          <td className="p-6 text-xs font-mono text-white/40">{new Date(log.timestamp).toLocaleString()}</td>
                          <td className="p-6">
                            <span className="px-2 py-1 rounded bg-orange-500/10 text-orange-500 text-[10px] font-bold uppercase">
                              {log.agent}
                            </span>
                          </td>
                          <td className="p-6 text-sm font-medium">{log.action}</td>
                          <td className="p-6 text-xs text-white/60 max-w-md leading-relaxed">{log.reasoning}</td>
                          <td className="p-6">
                            <div className="flex items-center text-green-500 text-[10px] font-bold uppercase">
                              <ShieldCheck size={12} className="mr-1" />
                              {log.status}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {logs.length === 0 && (
                    <div className="p-20 text-center text-white/20 font-mono text-sm">
                      No logs available. Trigger a simulation to see the agents in action.
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
