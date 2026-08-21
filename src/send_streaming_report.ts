import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { infraiEmailFromEnvironment } from "./infrai_email.js";
import { renderStreamingReport, type StreamingReport } from "./streaming_report.js";

const recipient = process.env.REPORT_RECIPIENT;
if (!recipient) throw new Error("REPORT_RECIPIENT is required");

const report: StreamingReport = {
  period: process.env.REPORT_PERIOD ?? "July 2026",
  activeViewers: 128_440,
  playbackHours: 391_205,
  completionRate: 0.684,
  topTitle: "Signal Coast",
};

const pdf = await renderStreamingReport(report);
const outputPath = `streaming-audience-${report.period.toLowerCase().replaceAll(" ", "-")}.pdf`;
await writeFile(outputPath, pdf);

const idempotencyKey = createHash("sha256")
  .update(`${recipient}:${report.period}:streaming-audience-report`)
  .digest("hex");

const infrai = { email: infraiEmailFromEnvironment() };
const result = await infrai.email.send(
  {
    to: recipient,
    subject: `Streaming audience report: ${report.period}`,
    html: `<h1>Streaming audience report</h1><p>The ${report.period} report is ready.</p><p>Active viewers: <strong>${report.activeViewers.toLocaleString("en-US")}</strong><br>Playback hours: <strong>${report.playbackHours.toLocaleString("en-US")}</strong><br>Completion rate: <strong>${(report.completionRate * 100).toFixed(1)}%</strong><br>Top title: <strong>${report.topTitle}</strong></p><p>PDF generated as <code>${outputPath}</code>.</p>`,
  },
  idempotencyKey,
);

console.log(JSON.stringify({ message_id: result.message_id, pdf: outputPath, metadata: result.metadata }, null, 2));
