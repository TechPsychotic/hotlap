import { useState } from "react";
import TopBar from "./components/TopBar";
import WindowManager from "./components/WindowManager";
import Landing from "./components/Landing";
import { useStore, stopLocalTimeline } from "./store";

export default function App() {
  const [entered, setEntered] = useState(false);
  const setLive = useStore((s) => s.setLive);

  if (!entered) return <Landing onEnter={() => setEntered(true)} />;

  return (
    <div className="app">
      <TopBar
        onHome={() => {
          stopLocalTimeline();
          setLive(false);
          setEntered(false);
        }}
      />
      <WindowManager />
    </div>
  );
}
