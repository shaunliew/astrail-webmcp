const shards = [
  { height: 300, left: "53%", rotate: -10, top: "39%", width: 50 },
  { height: 420, left: "64%", rotate: 7, top: "28%", width: 68 },
  { height: 330, left: "75%", rotate: -5, top: "45%", width: 54 },
  { height: 250, left: "86%", rotate: 11, top: "33%", width: 42 },
  { height: 360, left: "43%", rotate: 4, top: "54%", width: 44 },
  { height: 220, left: "92%", rotate: -7, top: "57%", width: 36 },
] as const;

type LightShardsProps = {
  className?: string;
};

export default function LightShards({ className = "" }: LightShardsProps) {
  return (
    <div className={`motion-shards ${className}`} aria-hidden="true">
      {shards.map((shard, index) => (
        <span
          className="motion-shard"
          key={`${shard.left}-${shard.top}`}
          style={{
            height: shard.height,
            left: shard.left,
            top: shard.top,
            transform: `rotate(${shard.rotate}deg)`,
            width: shard.width,
            ["--shard-index" as string]: index,
          }}
        />
      ))}
    </div>
  );
}
