"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function ActiveSessionMockup() {
  const router = useRouter();
  
  // Flow: ready -> connecting -> images -> math -> survey -> complete
  const [currentStep, setCurrentStep] = useState("ready"); 
  
  // Connection States
  const [isWaitingForBridge, setIsWaitingForBridge] = useState(false);
  const [pollingError, setPollingError] = useState("");
  
  // Image & Event Tracking States
  const [images, setImages] = useState([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  
  //Using useRef for the Event ID prevents stale data inside the 3-second timer
  const currentEventIdRef = useRef(null);

  // Math & Survey States
  const [currentMathIndex, setCurrentMathIndex] = useState(0);
  const [surveyAnswers, setSurveyAnswers] = useState({});
  const mathQuestions = ["What is 7 + 5?", "What is 18 - 9?", "What is 6 × 4?", "What is 36 ÷ 6 + 7?", "Solve for x: 3x + 5 = 20"];
  const bfi2Questions = ["Someone who is outgoing and comfortable interacting with others.", "Someone who is caring and tender-hearted toward others.", "Someone who tends to be less organized in managing daily matters.", "Someone who is calm and able to handle pressure well."];

  const getCleanToken = () => localStorage.getItem("token")?.replace(/^["']|["']$/g, '').trim();

  // ==========================================
  // 1. FETCH IMAGES ON LOAD
  // ==========================================
  useEffect(() => {
    const fetchImages = async () => {
      try {
        const res = await fetch("http://139.59.126.77/api/images", {
          headers: { "Authorization": `Bearer ${getCleanToken()}` }
        });
        if (res.ok) {
          const data = await res.json();
          setImages(data); 
        }
      } catch (err) {
        console.error("Failed to fetch images", err);
      }
    };
    fetchImages();
  }, []);

  // ==========================================
  // EVENT TRACKING HELPERS (Step 4)
  // ==========================================
  const logImageShown = async (imageId) => {
    if (!imageId) return;
    try {
      const sessionId = localStorage.getItem("currentSessionId");
      const res = await fetch("http://139.59.126.77/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getCleanToken()}` },
        body: JSON.stringify({ session_id: sessionId, image_id: imageId })
      });
      if (res.ok) {
        const data = await res.json();
        // Save to Ref instead of State
        currentEventIdRef.current = data.event_id || data.id; 
      }
    } catch (err) { console.error("Event start failed", err); }
  };

  const logImageHidden = async () => {
    const eventId = currentEventIdRef.current;
    if (!eventId) return;
    
    try {
      await fetch(`http://139.59.126.77/api/events/${eventId}/hide`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${getCleanToken()}` }
      });
      currentEventIdRef.current = null; // Clear it out
    } catch (err) { console.error("Event hide failed", err); }
  };

  // ==========================================
  // NEW: THE STRICT 3-SECOND AUTO-ADVANCE TIMER
  // ==========================================
  useEffect(() => {
    let timer;
    
    // Only run this timer IF we are in the images phase and images have loaded
    if (currentStep === "images" && images.length > 0) {
      
      // Set a strict 3000 millisecond delay
      timer = setTimeout(async () => {
        await logImageHidden(); // Close the current image in the DB
        
        if (currentImageIndex < images.length - 1) {
          // Move to the next image
          const nextIdx = currentImageIndex + 1;
          setCurrentImageIndex(nextIdx);
          await logImageShown(images[nextIdx].id || images[nextIdx].image_id);
        } else {
          // Sequence finished! Move to the math test
          setCurrentStep("math");
        }
      }, 3000);
    }

    // Cleanup: If the component unmounts or the index changes, clear the old timer
    return () => clearTimeout(timer);
  }, [currentStep, currentImageIndex, images]);

  // ==========================================
  // STEP 2 & 3: START AND POLL
  // ==========================================
  const handleStartRecording = async () => {
    setPollingError("");
    setIsWaitingForBridge(true);
    setCurrentStep("connecting"); 

    const sessionId = localStorage.getItem("currentSessionId");
    
    if (!sessionId || sessionId === "undefined") {
      setPollingError("Missing Session ID. Please pair again.");
      setIsWaitingForBridge(false);
      return;
    }

    try {
      const startRes = await fetch(`http://139.59.126.77/api/sessions/${sessionId}/start`, {
        method: "PATCH", 
        headers: { "Authorization": `Bearer ${getCleanToken()}` }
      });
      if (!startRes.ok) throw new Error("Failed to initialize session on the server.");

      let attempts = 0;
      const pollInterval = setInterval(async () => {
        attempts++;
        const checkRes = await fetch(`http://139.59.126.77/api/sessions/${sessionId}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${getCleanToken()}` }
        });
        
        if (checkRes.ok) {
          const sessionData = await checkRes.json();
          
          // DEMO BYPASS: "|| true" kept here for your testing without the C# app
          if (sessionData.bridge_recording_at !== null || true) {
            clearInterval(pollInterval);
            setIsWaitingForBridge(false);
            setCurrentStep("images");
            
            // Fire the POST event for the very first image!
            if (images.length > 0) {
              await logImageShown(images[0].id || images[0].image_id);
            }
            return;
          }
        }
        
        if (attempts >= 30) {
          clearInterval(pollInterval);
          setIsWaitingForBridge(false);
          setPollingError("headset not recording — check the bridge PC");
        }
      }, 1000);

    } catch (err) {
      setIsWaitingForBridge(false);
      setPollingError("Network error while connecting to the database.");
    }
  };

  const handleEndSession = async () => {
    try {
      const sessionId = localStorage.getItem("currentSessionId");
      await fetch(`http://139.59.126.77/api/sessions/${sessionId}/end`, {
        method: "PATCH", 
        headers: { "Authorization": `Bearer ${getCleanToken()}` }
      });
      setCurrentStep("complete");
    } catch (err) {
      console.error("End session failed", err);
      setCurrentStep("complete");
    }
  };

  const handleSurveyChange = (questionIndex, score) => {
    setSurveyAnswers(prev => ({ ...prev, [questionIndex]: score }));
  };

  // ==========================================
  // UI RENDER BLOCKS
  // ==========================================

  const renderReadyState = () => (
    <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-2xl mx-auto text-center animate-in fade-in">
      <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6 text-3xl">✓</div>
      <h2 className="text-3xl font-bold mb-4 text-slate-800">Session Claimed</h2>
      <p className="text-slate-500 mb-8">Ready to trigger the C# bridge sequence.</p>
      <button onClick={handleStartRecording} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-lg transition-all shadow-sm flex justify-center items-center gap-2 text-lg">
        Start Session 🟢
      </button>
    </div>
  );

  const renderConnecting = () => (
    <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-2xl mx-auto text-center animate-in zoom-in-95">
      <h2 className="text-3xl font-bold mb-4 text-slate-800">Awaiting Bridge</h2>
      {isWaitingForBridge ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
          <p className="text-blue-600 font-bold animate-pulse">Polling API for bridge_recording_at... ⏳</p>
        </div>
      ) : pollingError && (
        <div className="flex flex-col items-center gap-4">
          <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium uppercase tracking-wide">⚠️ {pollingError}</div>
          <button onClick={() => setCurrentStep("ready")} className="px-6 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-bold transition-colors">← Try Again</button>
        </div>
      )}
    </div>
  );

  const renderImageStimuli = () => {
    if (images.length === 0) {
      return (
        <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-4 text-slate-800">No images found in database!</h2>
          <button onClick={() => setCurrentStep("math")} className="px-6 py-2 bg-slate-200 rounded-lg font-bold">Skip to Math ⏭️</button>
        </div>
      );
    }

    const currentImg = images[currentImageIndex];

    return (
      <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center animate-in zoom-in-95">
        <div className="flex justify-between items-center mb-8 border-b border-slate-100 pb-4">
          <span className="text-red-600 font-bold animate-pulse flex items-center gap-2"><span className="h-3 w-3 bg-red-600 rounded-full"></span>EEG RECORDING ACTIVE</span>
          <span className="text-slate-500 font-mono text-sm">Image {currentImageIndex + 1} of {images.length}</span>
        </div>
        
        <h2 className="text-3xl font-bold mb-8 text-slate-800">{currentImg.name || "Visual Stimulus"}</h2>
        
        <div className="w-full h-96 bg-slate-100 rounded-lg flex items-center justify-center mb-6 border border-slate-200 shadow-inner overflow-hidden relative">
          <img src={currentImg.url || currentImg.image_url} alt="Stimulus" className="w-full h-full object-contain" onError={(e) => e.target.style.display = 'none'} />
        </div>

        {/* Removed the manual button and added an automated indicator */}
        <div className="text-slate-400 font-bold tracking-widest text-sm uppercase animate-pulse">
          Auto-advancing...
        </div>
      </div>
    );
  };

  const renderMathTest = () => (
    <div className="bg-white p-12 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto text-center animate-in zoom-in-95">
      <div className="flex justify-between items-center mb-8 border-b border-slate-100 pb-4">
        <span className="text-red-600 font-bold animate-pulse flex items-center gap-2"><span className="h-3 w-3 bg-red-600 rounded-full"></span>EEG RECORDING ACTIVE</span>
        <span className="text-slate-500 font-mono text-sm">Phase 2: Cognitive Task</span>
      </div>
      <h2 className="text-4xl font-bold mb-12 text-blue-600 tracking-tight">{mathQuestions[currentMathIndex]}</h2>
      <div className="flex justify-center gap-4 mt-8">
        <button onClick={() => { currentMathIndex < mathQuestions.length - 1 ? setCurrentMathIndex(currentMathIndex + 1) : setCurrentStep("survey") }} className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white shadow-sm rounded-lg font-bold text-lg">
          {currentMathIndex < mathQuestions.length - 1 ? "Next Question" : "Finish Recording ⏹️"}
        </button>
      </div>
    </div>
  );

  const renderSurvey = () => (
    <div className="bg-white p-8 rounded-xl shadow-md border border-slate-200 max-w-4xl mx-auto animate-in slide-in-from-bottom-4">
      <div className="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
        <div><h2 className="text-2xl font-bold text-slate-800 mb-1">Post-Session Survey</h2></div>
      </div>
      <div className="flex justify-end pt-4">
        <button onClick={handleEndSession} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg shadow-sm">
          Submit & End Session
        </button>
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans flex flex-col items-center justify-center">
      <div className="w-full max-w-6xl mb-8"><button onClick={() => router.push("/session")} className="text-slate-400 hover:text-slate-800 font-medium text-sm flex items-center gap-2">← Abort Session</button></div>
      <div className="w-full">
        {currentStep === "ready" && renderReadyState()}
        {currentStep === "connecting" && renderConnecting()}
        {currentStep === "images" && renderImageStimuli()}
        {currentStep === "math" && renderMathTest()}
        {currentStep === "survey" && renderSurvey()}
        {currentStep === "complete" && (
          <div className="text-center animate-in zoom-in">
            <div className="text-6xl mb-4">🎉</div>
            <h2 className="text-3xl font-bold text-slate-800 mb-2">Session Completed & Saved</h2>
            <button onClick={() => router.push("/session/history")} className="px-6 py-2 bg-slate-200 text-slate-700 rounded-lg font-bold mt-4">Return to Dashboard</button>
          </div>
        )}
      </div>
    </main>
  );
}