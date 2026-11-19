import { useRef, useState, type Ref } from 'react';

type Connection = { name: string; access: string };

export function EditConnections({
  connections = [],
  fieldsetRef,
}: {
  connections?: Connection[];
  fieldsetRef?: Ref<HTMLFieldSetElement>;
}) {
  const [rows, setRows] = useState(() =>
    connections.map((connection, id) => ({ ...connection, id })),
  );
  const nextId = useRef(connections.length);

  return (
    <fieldset className="gov-fieldset" ref={fieldsetRef} tabIndex={-1}>
      <legend>Connected systems</legend>
      {rows.map((row, index) => (
        <div className="governance-fields" key={row.id}>
          <label>
            Connected system {index + 1}
            <input name="connectionName" required defaultValue={row.name} />
          </label>
          <label>
            Connected system {index + 1} access
            <select name="connectionAccess" defaultValue={row.access} required>
              <option value="read">Read</option>
              <option value="write">Write</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              setRows(previous => previous.filter(item => item.id !== row.id))
            }
          >
            Remove connected system {index + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          const id = nextId.current++;
          setRows(previous => [...previous, { id, name: '', access: 'read' }]);
        }}
      >
        Add connected system
      </button>
    </fieldset>
  );
}
