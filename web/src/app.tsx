import { useState } from "react";
import TopBar from "./components/TopBar";
import WindowManager from "./components/WindowManager";
import Landing from "./components/Landing";

export default function App() {
  const [entered, setEntered] = useState(false);

  if (!entered) return <Landing onEnter={() => setEntered(true)} />;

  return (
    <div className="app">
      <TopBar onHome={() => setEntered(false)} />
      <WindowManager />
    </div>
  );
}
