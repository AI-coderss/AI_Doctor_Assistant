// ChatBubbleChart.jsx
import React, { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';

export default function ChatBubbleChart({ config }) {
  const merged = useMemo(() => {
    return {
      // sensible, larger defaults
      chart: {
        backgroundColor: 'transparent',
        height: 420,                // ⬅️ bigger chart height
        spacing: [16, 16, 16, 16],
        ...(config.chart || {}),
      },
      title: {
        style: { fontSize: '16px', fontWeight: '700' },
        ...(config.title || {}),
      },
      plotOptions: {
        pie: {
          size: '85%',              // ⬅️ larger pie diameter
          dataLabels: {
            style: { fontSize: '13px', fontWeight: '600' },
          },
          ...(config.plotOptions?.pie || {}),
        },
        ...(config.plotOptions || {}),
      },
      ...config,
    };
  }, [config]);

  return (
    <div className="bubble-chart">
      <HighchartsReact highcharts={Highcharts} options={merged} />
    </div>
  );
}
