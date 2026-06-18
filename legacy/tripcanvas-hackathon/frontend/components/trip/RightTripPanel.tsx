import { PlaceIntelPanel } from "@/components/trip/PlaceIntelPanel";
import type { TripDay, TripPlace } from "@/lib/trip/types";

export type RightPanelTab = "agent-run" | "place-intel";

type RightTripPanelProps = {
  activeTab: RightPanelTab;
  agentPanelContent?: React.ReactNode;
  days: TripDay[];
  selectedPlace: TripPlace | null;
  onSelectTab: (tab: RightPanelTab) => void;
};

export function RightTripPanel({
  activeTab,
  agentPanelContent,
  days,
  selectedPlace,
  onSelectTab,
}: RightTripPanelProps) {
  return (
    <aside className="absolute right-4 top-4 z-10 hidden max-h-[calc(100vh-2rem)] w-[390px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/82 shadow-2xl shadow-black/40 backdrop-blur-xl lg:flex">
      <div className="grid grid-cols-2 gap-2 border-b border-white/10 p-3">
        <TabButton
          active={activeTab === "agent-run"}
          disabled={!agentPanelContent}
          onClick={() => onSelectTab("agent-run")}
        >
          Agent Run
        </TabButton>
        <TabButton active={activeTab === "place-intel"} onClick={() => onSelectTab("place-intel")}>
          Place Intel
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {activeTab === "agent-run" && agentPanelContent ? (
          agentPanelContent
        ) : (
          <PlaceIntelPanel place={selectedPlace} days={days} />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  disabled,
  children,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "h-10 rounded-xl border text-xs font-black uppercase tracking-[0.16em] transition disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-amber-200/50 bg-amber-200/16 text-amber-100"
          : "border-white/10 bg-white/8 text-slate-300 hover:bg-white/12",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
