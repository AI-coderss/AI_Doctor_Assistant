import React, { useState, useEffect } from 'react';
import { Player } from '@lottiefiles/react-lottie-player';
import "../styles/Loader.css";

const Loader = ({ isLoading }) => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768); // Set breakpoint for mobile
    };

    handleResize(); // Initial check
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize); // Cleanup on unmount
    };
  }, []);

  const containerStyle = isMobile
    ? {
        width: '100px',
        height: '100px',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        position: 'fixed',
      }
    : {
        width: '200px',
        height: '200px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
      };

  const playerStyle = isMobile
    ? {
        width: '50%',
        marginTop: '50px',
        height: '50%',
        background: 'none',
      }
    : {
        width: '100%',
        marginTop: '100px',
        height: '100%',
        background: 'none',
      };

  return (
    <div style={containerStyle}>
      <Player
        className="loading"
        autoplay
        loop
        src={isLoading ? '/loading.json' : '/animation1.json'}
        style={playerStyle}
      />
      <div className="loader-container">
        <div className="animated-text">
          <div className="animated-text__letter">T</div>
          <div className="animated-text__letter">r</div>
          <div className="animated-text__letter">a</div>
          <div className="animated-text__letter">n</div>
          <div className="animated-text__letter">s</div>
          <div className="animated-text__letter">c</div>
          <div className="animated-text__letter">r</div>
          <div className="animated-text__letter">i</div>
          <div className="animated-text__letter">b</div>
          <div className="animated-text__letter">i</div>
          <div className="animated-text__letter">n</div>
          <div className="animated-text__letter">g</div>
          <div className="animated-text__letter">⚈</div>
          <div className="animated-text__letter">⚈</div>
          <div className="animated-text__letter">⚈</div>
        </div>
      </div>
    </div>
  );
};

export default Loader;