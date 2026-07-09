export const TD_LAYOUT_HELPERS = `
def _place(node, x, y):
    try:
        node.nodeX = int(x)
        node.nodeY = int(y)
    except Exception:
        pass

def _place_container(parent, container):
    try:
        cw, ch, rows = 260, 200, 6
        def _cell(child):
            return (
                round((child.nodeX + child.nodeWidth / 2.0) / cw),
                round(-(child.nodeY + child.nodeHeight / 2.0) / ch),
            )
        occupied = {_cell(child) for child in parent.children if child is not container}
        k = 0
        while (k // rows, k % rows) in occupied:
            k += 1
        container.nodeX = int((k // rows) * cw)
        container.nodeY = int(-((k % rows) * ch))
    except Exception:
        pass
`;
