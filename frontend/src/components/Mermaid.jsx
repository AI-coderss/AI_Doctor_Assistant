// src/components/Mermaid.js
import React, { useEffect, useRef } from 'react';
import mermaid from 'mermaid';

// Initialize only once
try {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'inherit',
  });
} catch (e) {
  console.error("Mermaid initialization failed", e);
}

const Mermaid = ({ chart }) => {
  const ref = useRef(null);

  useEffect(() => {
    if (!chart || !ref.current) return;

    const renderChart = async () => {
      try {
        mermaid.parse(chart); // validate syntax
        const { svg } = await mermaid.render(
          `mermaid-${Math.random().toString(36).substr(2, 9)}`,
          chart
        );
        ref.current.innerHTML = svg;
      } catch (e) {
        ref.current.innerHTML = `<pre>Invalid Mermaid syntax:\n${chart}</pre>`;
        console.error("Mermaid render failed:", e);
      }
    };

    renderChart();
  }, [chart]);

  return <div key={chart} ref={ref} />;
};

export default Mermaid;