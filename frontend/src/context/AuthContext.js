"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { getCurrentUser, logout, setAuthToken } from "@/utils/api";

const AuthContext = createContext(null);
const AUTH_CHANNEL_NAME = "neurostudy-auth"
const LOGOUT_MESSAGE = "logout"

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const sessionVersion = useRef(0);
  const channelRef = useRef(null)

  const clearLocalSession = () => {
    sessionVersion.current += 1
    setAuthToken(null)
    setUser(null)
    setIsLoading(false)
  }

  useEffect(() => {
    if (!("BroadcastChannel" in window))
      return

    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME)
    channelRef.current = channel

    channel.onmessage = event => {
      if (event.data?.type !== LOGOUT_MESSAGE)
        return

      clearLocalSession()
      window.location.assign("/login")
    }

    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [])


  useEffect(() => {
    let active = true;
    const version = sessionVersion.current;

    const restoreSession = async () => {
      try {
        // fetchWithAuth will use the HttpOnly refresh cookie to obtain an
        // in-memory access token when the app is loaded or refreshed.
        const response = await getCurrentUser();
        if (response.ok && active && version === sessionVersion.current) setUser(await response.json());
      } catch {
        if (active && version === sessionVersion.current) setUser(null);
      } finally {
        if (active && version === sessionVersion.current) setIsLoading(false);
      }
    };

    restoreSession();
    return () => { active = false; };
  }, []);

  const signIn = ({ accessToken, user: nextUser }) => {
    sessionVersion.current += 1;
    setAuthToken(accessToken);
    setUser(nextUser);
    setIsLoading(false);
  };

  const signOut = async () => {
    sessionVersion.current += 1
    setUser(null)
    setIsLoading(false)
    try {
      await logout();
    } finally {
      setAuthToken(null)
      channelRef.current?.postMessage({ type: LOGOUT_MESSAGE })
    }
  };

  const value = {
    user,
    isLoading,
    isAuthenticated: Boolean(user),
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
