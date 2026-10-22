export function BadPage(props: { onSave: () => void }) {
  return (
    <section>
      <h1>新建总结</h1>
      <input placeholder="Paste a link, one per line." />
      <button title="保存" onClick={props.onSave}>
        Save
      </button>
      <p>{`共 ${3} 条`}</p>
    </section>
  );
}

export const notice = "Something went wrong, try again";
