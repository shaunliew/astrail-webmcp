const nodes = [
  { cx: 13, cy: 68 },
  { cx: 31, cy: 42 },
  { cx: 48, cy: 61 },
  { cx: 65, cy: 34 },
  { cx: 84, cy: 51 },
] as const;

type ScrollTrailProps = {
  className?: string;
};

export default function ScrollTrail({ className = "" }: ScrollTrailProps) {
  return (
    <svg
      aria-hidden="true"
      className={`motion-route ${className}`}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <path
        className="motion-route__glow"
        d="M13 68 C22 53 24 45 31 42 C39 38 41 60 48 61 C56 62 58 40 65 34 C72 29 75 50 84 51"
      />
      <path
        className="motion-route__ghost"
        d="M13 68 C22 53 24 45 31 42 C39 38 41 60 48 61 C56 62 58 40 65 34 C72 29 75 50 84 51"
        pathLength={1}
      />
      <path
        className="motion-route__draw"
        d="M13 68 C22 53 24 45 31 42 C39 38 41 60 48 61 C56 62 58 40 65 34 C72 29 75 50 84 51"
        pathLength={1}
      />
      {nodes.map((node, index) => (
        <g key={`${node.cx}-${node.cy}`}>
          <circle
            className="motion-route__node-glow"
            cx={node.cx}
            cy={node.cy}
            r={index === nodes.length - 1 ? 3.6 : 2.8}
          />
          <circle
            className="motion-route__node"
            cx={node.cx}
            cy={node.cy}
            r={index === nodes.length - 1 ? 1.4 : 1.05}
            style={{ ["--node-index" as string]: index }}
          />
        </g>
      ))}
    </svg>
  );
}
