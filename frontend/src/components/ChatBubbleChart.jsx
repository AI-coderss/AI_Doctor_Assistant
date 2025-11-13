// ChatBubbleChart.jsx
import React, { useMemo } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";

// --- Modules --------------------------------------------------------------
// Highcharts v12: modules auto-initialize by just importing.
// Highcharts v11 and below: the import returns a function and must be called.
// The guard below supports both.

import HCMore from "highcharts/highcharts-more";            // bubble, polar, etc (safe even if unused)
import Exporting from "highcharts/modules/exporting";
import Accessibility from "highcharts/modules/accessibility";

// Back-compat init (v11−) – no-op on v12 (where not a function)
[HCMore, Exporting, Accessibility].forEach((m) => {
  const fn =
    typeof m === "function" ? m :
    typeof m?.default === "function" ? m.default :
    null;
  if (fn) fn(Highcharts);
});

export default function ChatBubbleChart({ config }) {
  const merged = useMemo(
    () => ({
      chart: {
        backgroundColor: "transparent",
        height: 600,
        spacing: [16, 16, 16, 16],
        ...(config?.chart || {}),
      },
      title: {
        style: { fontSize: "18px", fontWeight: 700 },
        ...(config?.title || {}),
      },
      plotOptions: {
        pie: {
          size: "100%",
          dataLabels: {
            distance: 14,
            style: { fontSize: "14px", fontWeight: 600 },
          },
          ...(config?.plotOptions?.pie || {}),
        },
        ...(config?.plotOptions || {}),
      },
      credits: { enabled: false },
      exporting: { enabled: false },
      ...config,
    }),
    [config]
  );

  return (
    <div className="bubble-chart">
      <HighchartsReact highcharts={Highcharts} options={merged} />
    </div>
  );
}
