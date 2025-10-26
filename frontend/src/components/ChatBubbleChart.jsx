// ChatBubbleChart.jsx
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';

export default function ChatBubbleChart({ config }) {
  if (!config) return null;
  return (
    <div className="chat-bubble ai" style={{ background: 'transparent', padding: 8 }}>
      <HighchartsReact highcharts={Highcharts} options={config} />
    </div>
  );
}
