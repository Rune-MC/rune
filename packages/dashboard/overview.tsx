/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { bytes, Card, Details, elapsed, number, Table, Utc } from "./ui.tsx";

export type OverviewData = { snapshot?: RuneDashboardSnapshot; samples: RuneDashboardSample[] };
type Series = "cpu" | "rss" | "mspt" | "players";
const colors = { cpu: "#7ce6bb", rss: "#8abff1", mspt: "#f6d293", players: "#d5b2f0" };

function Timeline({ title, note, series, samples }: { title: string; note: string; series: Series; samples: RuneDashboardSample[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const points = samples.flatMap((sample) => {
    const value = sample[series];
    return value != null && Number.isFinite(value) ? [{ at: sample.at, value }] : [];
  });
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.scale(ratio, ratio);
      const end = points.at(-1);
      if (!end) return;
      const from = points[0].at;
      const span = Math.max(1, end.at - from);
      const top = Math.max(series === "mspt" ? 50 : 1, ...points.map((point) => point.value)) * 1.1;
      const plotHeight = height - 8;
      context.strokeStyle = "#2b3947";
      for (let row = 1; row <= 4; row++) {
        context.beginPath();
        const y = plotHeight * row / 4;
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      context.beginPath();
      const coordinates = points.map(({ at, value }) => ({ x: (width - 8) * (at - from) / span + 4, y: plotHeight * (1 - value / top) + 4 }));
      for (const [index, { x, y }] of coordinates.entries()) index ? context.lineTo(x, y) : context.moveTo(x, y);
      context.strokeStyle = colors[series];
      context.lineWidth = 2;
      context.stroke();
      const { x, y } = coordinates.at(-1)!;
      context.beginPath();
      context.arc(x, y, 3, 0, Math.PI * 2);
      context.fillStyle = colors[series];
      context.fill();
    };
    draw();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [series, samples]);
  const printable = (value: number) => series === "rss" ? bytes(value) :
    number(value, series === "players" ? 0 : 1) + (series === "cpu" ? "%" : series === "mspt" ? " ms" : "");
  const values = points.map((point) => point.value);
  return <section className="card chart">
    <h2>{title}</h2><p>{note}</p><canvas ref={ref} aria-hidden="true" />
    <p>{values.length ? <>Latest {printable(values.at(-1)!)} · Peak {printable(Math.max(...values))}</> : "Waiting for samples"}</p>
  </section>;
}

function Metric({ label, value, units }: { label: string; value: string; units: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{units}</small></div>;
}

export function Overview({ initial }: { initial: OverviewData }) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let request: AbortController | undefined;
    let disposed = false;
    const poll = async () => {
      if (request || document.hidden) return;
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 4500);
      try {
        const response = await fetch("/api/overview", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Dashboard metrics request failed");
        const overview: OverviewData = await response.json();
        if (!disposed) { setData(overview); setStale(false); }
      } catch {
        if (!disposed) setStale(true);
      } finally {
        clearTimeout(timeout);
        request = undefined;
      }
    };
    void poll();
    const interval = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      disposed = true;
      request?.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);
  const { host, process } = data.snapshot ?? {};
  const jvm = host?.jvm;
  const sample = data.samples.at(-1);
  return <>
    <p className="muted">{stale ? "Live updates paused. Retrying…" : sample ? <>Sample from <Utc value={sample.at} /></> : "Waiting for the first server sample"}</p>
    <div className="grid">
      <Metric label="Tick rate" value={number(sample?.tps)} units="TPS · one-minute average" />
      <Metric label="Tick duration" value={number(sample?.mspt)} units="ms per tick · 50 ms target" />
      <Metric label="Players online" value={number(sample?.players, 0)} units={`of ${host?.server.capacity ?? "—"} slots`} />
      <Metric label="Process memory" value={bytes(sample?.rss)} units="Resident memory across the JVM and runtimes" />
    </div>
    <div className="grid charts">
      <Timeline title="Tick duration" note="Milliseconds per tick · last 15 minutes" series="mspt" samples={data.samples} />
      <Timeline title="Process CPU" note="100% represents one fully occupied core" series="cpu" samples={data.samples} />
      <Timeline title="Resident memory" note="Whole-process memory · last 15 minutes" series="rss" samples={data.samples} />
      <Timeline title="Players online" note="Connected players · last 15 minutes" series="players" samples={data.samples} />
    </div>
    <div className="grid">
      <Card title="Process"><Details values={{
        PID: process?.pid, Host: process?.platform, "CPU cores": process?.cores,
        "Process CPU": sample?.cpu == null ? null : number(sample.cpu) + "%",
        "Physical memory": bytes(process?.physicalMemory), "System memory free": bytes(process?.freeMemory),
        Uptime: elapsed(jvm?.uptimeMs ?? process?.uptimeMs),
      }} /></Card>
      <Card title="Java VM"><Details values={{
        "Java version": host?.server.java, "Heap used": bytes(jvm?.heapUsed), "Committed": bytes(jvm?.heapCommitted),
        "Heap maximum": bytes(jvm?.heapMax), "Non-heap memory": bytes(jvm?.nonHeapUsed),
        Threads: jvm?.threads, "Peak threads": jvm?.peakThreads,
      }} /></Card>
      <Card title="Node runtime"><Details values={{
        Node: process?.node, "V8 heap used": bytes(process?.heapUsed), "V8 heap allocated": bytes(process?.heapTotal),
        "External memory": bytes(process?.external), "Array buffers": bytes(process?.arrayBuffers),
        "Event loop utilization": process ? number(process.eventLoop) + "%" : null,
      }} /></Card>
    </div>
    <Table title="Garbage collectors" columns={["Collector", "Collections", "Time (ms)"]}
      rows={(jvm?.gc ?? []).map((gc) => ({ key: gc.name, cells: [gc.name, gc.collections, gc.timeMs] }))}
      empty="Garbage collector statistics will appear after the first server sample." />
  </>;
}
