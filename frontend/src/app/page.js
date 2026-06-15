"use client";
import { useState, useEffect } from "react";

export default function Home() {
  // 1. We create a memory space to hold the backend's response
  const [serverStatus, setServerStatus] = useState("Trying to connect...");

  // 2. useEffect runs this connection code the moment the page loads
  useEffect(() => {
    
    // 3. THIS IS THE CONNECTION: We 'fetch' data from Eugene's API endpoint
    fetch("http://localhost:5000/api/health")
      .then((response) => {
        if (!response.ok) throw new Error("Network response was not ok");
        return response.json(); // Convert the response into readable data
      })
      .then((data) => {
        // 4. We save the successful data into our memory space
        setServerStatus(`Success! The backend says: ${data.status}`);
      })
      .catch((error) => {
        // 5. If it fails, we show an error
        setServerStatus("Failed to connect. Is the backend running on port 5000?");
      });
      
  }, []); // The empty brackets mean "only run this connection test once"

  return (
    <main style={{ padding: "50px", fontFamily: "sans-serif", textAlign: "center" }}>
      <h1>NeuroStudy Connection Test</h1>
      
      <div style={{ marginTop: "20px", padding: "20px", background: "#e0f2fe", borderRadius: "8px", display: "inline-block" }}>
        <p style={{ fontSize: "18px", fontWeight: "bold", color: "#0369a1" }}>
          {serverStatus}
        </p>
      </div>
    </main>
  );
}