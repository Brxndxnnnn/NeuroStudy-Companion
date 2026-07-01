// src/utils/api.js

export async function fetchWithAuth(url, options = {}) {
  // 1. Grab the current token from local storage
  let token = localStorage.getItem("token");

  // 2. Merge any custom headers with our default Auth headers
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // 3. Attempt the original API call
  let response = await fetch(url, { ...options, headers });

  // 4. If it succeeds, or fails for a non-auth reason (like a 404), return it immediately
  if (response.status !== 401) {
    return response;
  }

  // 5. If we hit a 401, our access token is dead. Time to attempt a silent refresh!
  try {
    const refreshRes = await fetch("http://139.59.126.77/api/auth/refresh", {
      method: "POST",
      // CRITICAL: 'include' tells the browser to attach Eugene's HttpOnly cookie!
      credentials: "include", 
      headers: { "Content-Type": "application/json" }
    });

    if (refreshRes.ok) {
      // 6. Refresh successful! Grab the new token
      const data = await refreshRes.json();
      token = data.accessToken;

      // Update local storage so the rest of the app knows about the new token
      localStorage.setItem("token", token);

      // Update the headers with the brand new token
      headers["Authorization"] = `Bearer ${token}`;

      // 7. Retry the ORIGINAL request and return the result
      return await fetch(url, { ...options, headers });
      
    } else {
      // 8. If the refresh request ALSO fails, the user's session is truly dead.
      throw new Error("Session completely expired");
    }
  } catch (error) {
    // 9. Nuke the local storage and force a hard redirect to the login page
    localStorage.removeItem("token");
    localStorage.removeItem("userRole");
    window.location.href = "/login"; 
    
    return Promise.reject(error);
  }
}