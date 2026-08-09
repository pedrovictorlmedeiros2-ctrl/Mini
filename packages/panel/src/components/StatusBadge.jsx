const STYLES = {
  RUNNING: "ok",
  STOPPED: "dim",
  STARTING: "warn",
  STOPPING: "warn",
  RESTARTING: "warn",
  CREATING: "warn",
  INSTALLING: "warn",
  BACKING_UP: "warn",
  RESTORING: "warn",
  RECOVERING: "warn",
  DELETING: "warn",
  CRASHED: "danger",
  ERROR: "danger",
  SUSPENDED: "danger",
  DELETED: "dim",
  ACTIVE: "ok",
  MAINTENANCE: "warn",
  DRAINING: "warn",
  OFFLINE: "danger",
  PENDING: "dim",
  APPROVED: "ok",
  DECLINED: "danger",
  CANCELLED: "dim",
  EXPIRED: "dim",
  PROVISIONING: "warn",
  PROVISIONED: "ok",
  FAILED: "danger",
  COMPLETED: "ok",
};

const LABELS = {
  RUNNING: "Online",
  STOPPED: "Offline",
  OFFLINE: "Offline",
};

export default function StatusBadge({ status }) {
  const style = STYLES[status] || "dim";
  return (
    <span className={`badge ${style}`}>
      <span className="dot" />
      {LABELS[status] || status}
    </span>
  );
}
