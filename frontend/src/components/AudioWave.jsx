import React, { useEffect, useRef } from 'react';
import '../styles/AudioWave.css';

const AudioWave = ({ stream, audioUrl, onEnded }) => {
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameIdRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.parentElement?.clientWidth || 600;

    canvas.height = 300;

    const turbulenceFactor = 0.25;
    const maxAmplitude = canvas.height / 3.5;
    const baseLine = canvas.height / 2;
    const numberOfWaves = 10;
    let globalTime = 0;

    const createGradient = () => {
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, 'rgba(255, 25, 255, 0.2)');
      gradient.addColorStop(0.5, 'rgba(25, 255, 255, 0.75)');
      gradient.addColorStop(1, 'rgba(255, 255, 25, 0.2)');
      return gradient;
    };

    const gradient = createGradient();

    const drawWave = (dataArray) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      globalTime += 0.05;

      for (let j = 0; j < numberOfWaves; j++) {
        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = gradient;

        let x = 0;
        const sliceWidth = canvas.width / dataArray.length;
        let lastX = 0;
        let lastY = baseLine;

        for (let i = 0; i < dataArray.length; i++) {
          const v = dataArray[i] / 128.0;
          const mid = dataArray.length / 2;
          const distanceFromMid = Math.abs(i - mid) / mid;
          const dampFactor = 1 - Math.pow((2 * i) / dataArray.length - 1, 2);
          const amplitude = maxAmplitude * dampFactor * (1 - distanceFromMid);
          const isWaveInverted = j % 2 ? 1 : -1;
          const frequency = isWaveInverted * (0.05 + turbulenceFactor);
          const y = baseLine + Math.sin(i * frequency + globalTime + j) * amplitude * v;

          if (i === 0) ctx.moveTo(x, y);
          else {
            const xc = (x + lastX) / 2;
            const yc = (y + lastY) / 2;
            ctx.quadraticCurveTo(lastX, lastY, xc, yc);
          }

          lastX = x;
          lastY = y;
          x += sliceWidth;
        }

        ctx.lineTo(canvas.width, lastY);
        ctx.stroke();
      }
    };

    const animate = () => {
      const analyser = analyserRef.current;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      analyser.getByteFrequencyData(dataArray);
      drawWave(dataArray);
      animationFrameIdRef.current = requestAnimationFrame(animate);
    };

    const setupFromStream = (stream) => {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      animate();
    };

    const setupFromAudio = (url) => {
      const audio = new Audio(url);
      audio.crossOrigin = 'anonymous';
      audio.play();

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioContext.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioContext.destination);

      animate();

      audio.addEventListener('ended', () => {
        onEnded?.();
        cancelAnimationFrame(animationFrameIdRef.current);
        if (audioContext.state !== 'closed') audioContext.close();
      });
    };

    if (stream) setupFromStream(stream);
    else if (audioUrl) setupFromAudio(audioUrl);

    return () => {
      cancelAnimationFrame(animationFrameIdRef.current);
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [stream, audioUrl, onEnded]);

  return (
    <div className="container">
      <canvas ref={canvasRef} id="waveCanvas"></canvas>
    </div>
  );
};

export default AudioWave;