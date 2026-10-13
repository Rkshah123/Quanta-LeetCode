/* ========================= algorithm / visualizer ========================
   A step recorder, not an animator.

   Every algorithm here is written as an ordinary function that returns the
   list of frames it went through, rather than as code that draws itself while
   it runs. That one decision is what makes the whole feature trustworthy:

     - playback is just walking an array, so stepping back, jumping, changing
       speed and scrubbing are all the same operation;
     - the frame count is known before anything is drawn, so the scrubber can
       show real positions instead of guessing;
     - the explanation text for a frame is produced by the same code that
       produced the frame, so the narration can never describe something the
       picture does not show;
     - an algorithm can be tested against its expected output with no DOM at
       all, which is how scripts/test-visualizer.js checks these.

   Frame shape:
     { title, note, array?, pointers?, bars?, nodes?, edges?, line? }

   Only the fields an algorithm uses are present, and the renderer ignores the
   rest, so adding an algorithm does not mean changing the player. */

const vizSorters = {
  bubble: {
    label: "Bubble sort",
    complexity: "O(n²)",
    note: "Repeatedly swap adjacent pairs that are out of order. After pass k the k largest values have bubbled to the end.",
    run(input) {
      const a = input.slice();
      const frames = [{ title: "Start", note: `Sorting ${a.length} values.`, array: a.slice() }];
      for (let i = 0; i < a.length; i += 1) {
        let swapped = false;
        for (let j = 0; j < a.length - i - 1; j += 1) {
          if (a[j] > a[j + 1]) {
            [a[j], a[j + 1]] = [a[j + 1], a[j]];
            swapped = true;
            frames.push({
              title: `Pass ${i + 1}, compare ${j} and ${j + 1}`,
              note: `${a[j + 1]} < ${a[j + 1]}, so they swap.`,
              array: a.slice(),
              pointers: [j, j + 1],
              sorted: a.length - i
            });
          } else {
            frames.push({
              title: `Pass ${i + 1}, compare ${j} and ${j + 1}`,
              note: `${a[j]} <= ${a[j + 1]}, already in order.`,
              array: a.slice(),
              pointers: [j, j + 1],
              sorted: a.length - i
            });
          }
        }
        if (!swapped) {
          frames.push({ title: "No swaps this pass", note: "The array is sorted, so we can stop early.", array: a.slice(), sorted: a.length });
          break;
        }
      }
      frames.push({ title: "Sorted", note: "Every value is in place.", array: a.slice(), sorted: a.length });
      return { frames, result: a };
    }
  },

  selection: {
    label: "Selection sort",
    complexity: "O(n²)",
    note: "Find the smallest remaining value and swap it to the front. Only one swap per pass.",
    run(input) {
      const a = input.slice();
      const frames = [{ title: "Start", note: `Sorting ${a.length} values.`, array: a.slice() }];
      for (let i = 0; i < a.length; i += 1) {
        let min = i;
        for (let j = i + 1; j < a.length; j += 1) {
          if (a[j] < a[min]) {
            min = j;
            frames.push({ title: `New smallest at ${j}`, note: `${a[j]} is smaller, remember it.`, array: a.slice(), pointers: [i, min], sorted: i });
          }
        }
        if (min !== i) [a[i], a[min]] = [a[min], a[i]];
        frames.push({ title: `Place ${a[i]} at index ${i}`, note: `The smallest of the rest is now in position.`, array: a.slice(), pointers: [i], sorted: i + 1 });
      }
      frames.push({ title: "Sorted", note: "Every value is in place.", array: a.slice(), sorted: a.length });
      return { frames, result: a };
    }
  },

  insertion: {
    label: "Insertion sort",
    complexity: "O(n²), near O(n) when nearly sorted",
    note: "Take each value and shift it left until it is in the right place. This is what most people actually do by hand.",
    run(input) {
      const a = input.slice();
      const frames = [{ title: "Start", note: `Sorting ${a.length} values.`, array: a.slice(), sorted: 1 }];
      for (let i = 1; i < a.length; i += 1) {
        const key = a[i];
        let j = i - 1;
        frames.push({ title: `Pick up ${key}`, note: "Lift this value out and slide everything bigger right.", array: a.slice(), pointers: [i], sorted: i });
        while (j >= 0 && a[j] > key) {
          a[j + 1] = a[j];
          frames.push({ title: `Shift ${a[j]} right`, note: `${a[j]} is bigger than ${key}.`, array: a.slice(), pointers: [j, j + 1], sorted: i });
          j -= 1;
        }
        a[j + 1] = key;
        frames.push({ title: `Insert ${key}`, note: `It lands at index ${j + 1}.`, array: a.slice(), pointers: [j + 1], sorted: i + 1 });
      }
      frames.push({ title: "Sorted", note: "Every value is in place.", array: a.slice(), sorted: a.length });
      return { frames, result: a };
    }
  },

  merge: {
    label: "Merge sort",
    complexity: "O(n log n)",
    note: "Split in half, sort each half, then merge the two sorted runs. The recursion is shown as the frames unfold.",
    run(input) {
      const a = input.slice();
      const frames = [{ title: "Start", note: `Sorting ${a.length} values.`, array: a.slice() }];
      const sort = (lo, hi) => {
        if (hi - lo <= 1) return;
        const mid = (lo + hi) >> 1;
        frames.push({ title: `Split [${lo}, ${hi})`, note: `Split into [${lo}, ${mid}) and [${mid}, ${hi}).`, array: a.slice(), pointers: [lo, hi - 1] });
        sort(lo, mid);
        sort(mid, hi);
        const left = a.slice(lo, mid);
        const right = a.slice(mid, hi);
        let i = 0;
        let j = 0;
        let k = lo;
        frames.push({ title: "Merge", note: `Merging [${left.join(", ")}] and [${right.join(", ")}].`, array: a.slice(), pointers: [lo, hi - 1] });
        while (i < left.length && j < right.length) {
          if (left[i] <= right[j]) a[k++] = left[i++];
          else a[k++] = right[j++];
          frames.push({ title: "Merge step", note: `Taking ${a[k - 1]} into position ${k - 1}.`, array: a.slice(), pointers: [k - 1] });
        }
        while (i < left.length) { a[k++] = left[i++]; frames.push({ title: "Merge rest", note: `Left side had more.`, array: a.slice(), pointers: [k - 1] }); }
        while (j < right.length) { a[k++] = right[j++]; frames.push({ title: "Merge rest", note: `Right side had more.`, array: a.slice(), pointers: [k - 1] }); }
        frames.push({ title: "Merged", note: `[${lo}, ${hi}) is sorted.`, array: a.slice(), pointers: [lo, hi - 1] });
      };
      sort(0, a.length);
      frames.push({ title: "Sorted", note: "Every value is in place.", array: a.slice(), sorted: a.length });
      return { frames, result: a };
    }
  },

  quick: {
    label: "Quicksort",
    complexity: "O(n log n) average, O(n²) worst",
    note: "Pick a pivot, put everything smaller to its left, then recurse into both sides.",
    run(input) {
      const a = input.slice();
      const frames = [{ title: "Start", note: `Sorting ${a.length} values.`, array: a.slice() }];
      const sort = (lo, hi) => {
        if (lo > hi) return;
        if (lo === hi) {
          frames.push({ title: `Single value ${a[lo]}`, note: "Nothing to do.", array: a.slice(), pointers: [lo] });
          return;
        }
        const pivot = a[hi];
        frames.push({ title: `Pivot ${pivot}`, note: `Use the last value as the pivot for [${lo}, ${hi}].`, array: a.slice(), pointers: [hi] });
        let i = lo;
        for (let j = lo; j < hi; j += 1) {
          if (a[j] < pivot) {
            [a[i], a[j]] = [a[j], a[i]];
            frames.push({ title: `Swap into the left side`, note: `${pivot} is bigger than ${a[i]}, so it joins the left group.`, array: a.slice(), pointers: [i, j, hi] });
            i += 1;
          }
        }
        [a[i], a[hi]] = [a[hi], a[i]];
        frames.push({ title: `Pivot lands at ${i}`, note: `${pivot} is now in its final position.`, array: a.slice(), pointers: [i] });
        sort(lo, i - 1);
        sort(i + 1, hi);
      };
      sort(0, a.length - 1);
      frames.push({ title: "Sorted", note: "Every value is in place.", array: a.slice(), sorted: a.length });
      return { frames, result: a };
    }
  },

  heap: {
    label: "Heap sort",
    complexity: "O(n log n)",
    note: "Build a max heap, then repeatedly move the biggest value to the end.",
    run(input) {
      const a = input.slice();
      const frames = [{ title: "Start", note: `Sorting ${a.length} values.`, array: a.slice() }];
      const sift = (size, root, label) => {
        while (true) {
          const left = root * 2 + 1;
          const right = left + 1;
          let biggest = root;
          if (left < size && a[left] > a[biggest]) biggest = left;
          if (right < size && a[right] > a[biggest]) biggest = right;
          if (biggest === root) return;
          [a[root], a[biggest]] = [a[biggest], a[root]];
          frames.push({ title: label, note: `Swap ${a[biggest]} down to keep the heap property.`, array: a.slice(), pointers: [root, biggest] });
          root = biggest;
        }
      };
      for (let i = Math.floor(a.length / 2) - 1; i >= 0; i -= 1) sift(a.length, i, "Build heap");
      frames.push({ title: "Heap built", note: "The biggest value is now at the root.", array: a.slice(), pointers: [0] });
      for (let end = a.length - 1; end > 0; end -= 1) {
        [a[0], a[end]] = [a[end], a[0]];
        frames.push({ title: `Move ${a[end]} to the end`, note: `Index ${end} is now final.`, array: a.slice(), pointers: [0, end], sorted: a.length - end });
        sift(end, 0, "Sift down");
      }
      frames.push({ title: "Sorted", note: "Every value is in place.", array: a.slice(), sorted: a.length });
      return { frames, result: a };
    }
  }
};

const vizSearchers = {
  linear: {
    label: "Linear search",
    complexity: "O(n)",
    note: "Check every value in turn. Works on anything, sorted or not.",
    run(input, target) {
      const frames = [{ title: "Start", note: `Looking for ${target}.`, array: input.slice() }];
      for (let i = 0; i < input.length; i += 1) {
        const hit = input[i] === target;
        frames.push({
          title: `Check index ${i}`,
          note: hit ? `Found ${target} at index ${i}.` : `${input[i]} is not ${target}, keep going.`,
          array: input.slice(),
          pointers: [i],
          found: hit ? i : null
        });
        if (hit) return { frames, result: { index: i, comparisons: i + 1 }, found: true };
      }
      frames.push({ title: "Not found", note: `${target} is not in the array.`, array: input.slice() });
      return { frames, result: { index: -1, comparisons: input.length }, found: false };
    }
  },

  binary: {
    label: "Binary search",
    complexity: "O(log n)",
    note: "Halve the range each step. Only works on a sorted array - which is why the sorted range is marked.",
    run(input, target) {
      const frames = [{ title: "Start", note: `Looking for ${target} in a sorted array.`, array: input.slice() }];
      let lo = 0;
      let hi = input.length - 1;
      let steps = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        steps += 1;
        const value = input[mid];
        frames.push({
          title: `Middle of [${lo}, ${hi}] is ${value}`,
          note: value === target
            ? `Found ${target} at index ${mid}.`
            : value < target
              ? `Too small, search the right half.`
              : `Too big, search the left half.`,
          array: input.slice(),
          pointers: [lo, mid, hi],
          range: [lo, hi],
          found: value === target ? mid : null
        });
        if (value === target) return { frames, result: { index: mid, comparisons: steps }, found: true };
        if (value < target) lo = mid + 1;
        else hi = mid - 1;
      }
      frames.push({ title: "Not found", note: `The range emptied, so ${target} is not present.`, array: input.slice() });
      return { frames, result: { index: -1, comparisons: steps }, found: false };
    }
  },

  exponential: {
    label: "Exponential search",
    complexity: "O(log n)",
    note: "Double a bound until it overshoots the target, then binary search inside. Best when the target is near the start.",
    run(input, target) {
      const frames = [{ title: "Start", note: `Looking for ${target}.`, array: input.slice() }];
      if (input[0] === target) {
        frames.push({ title: "Found at index 0", note: "It is the first value.", array: input.slice(), pointers: [0], found: 0 });
        return { frames, result: { index: 0, comparisons: 1 }, found: true };
      }
      let bound = 1;
      let steps = 1;
      while (bound < input.length && input[bound] <= target) {
        frames.push({ title: `Bound ${bound} is ${input[bound]}`, note: `${input[bound]} <= ${target}, so the answer is further right.`, array: input.slice(), pointers: [bound] });
        bound *= 2;
        steps += 1;
      }
      const hi = Math.min(bound - 1, input.length - 1);
      let lo = bound / 2 || 1;
      frames.push({ title: `Binary search [${lo}, ${hi}]`, note: `The target must be in here.`, array: input.slice(), pointers: [lo, hi], range: [lo, hi] });
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        steps += 1;
        const value = input[mid];
        frames.push({
          title: `Middle is ${value}`,
          note: value === target ? `Found ${target} at index ${mid}.` : value < target ? "Search right." : "Search left.",
          array: input.slice(),
          pointers: [lo, mid, hi],
          found: value === target ? mid : null
        });
        if (value === target) return { frames, result: { index: mid, comparisons: steps }, found: true };
        if (value < target) lo = mid + 1;
        else hi = mid - 1;
      }
      frames.push({ title: "Not found", note: `${target} is not in the array.`, array: input.slice() });
      return { frames, result: { index: -1, comparisons: steps }, found: false };
    }
  },

  lowerBound: {
    label: "Lower bound",
    complexity: "O(log n)",
    note: "Find the first index where the value could sit, which is where you would insert it.",
    run(input, target) {
      const frames = [{ title: "Start", note: `First index where a value >= ${target} could go.`, array: input.slice() }];
      let lo = 0;
      let hi = input.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const goLeft = input[mid] < target;
        frames.push({
          title: `Middle of [${lo}, ${hi}) is ${input[mid]}`,
          note: goLeft ? `${input[mid]} < ${target}, so look right.` : `${input[mid]} >= ${target}, so it could be the answer.`,
          array: input.slice(),
          pointers: [lo, mid, hi],
          range: [lo, Math.max(lo, hi - 1)],
          found: goLeft ? null : mid
        });
        if (goLeft) lo = mid + 1;
        else hi = mid;
      }
      frames.push({
        title: `Answer: ${lo}`,
        note: lo === input.length ? `${target} would go at the end.` : `${input[lo]} is the first value >= ${target}.`,
        array: input.slice(),
        pointers: [Math.min(lo, input.length - 1)],
        found: lo < input.length ? lo : null
      });
      return { frames, result: { index: lo, comparisons: frames.length }, found: lo < input.length };
    }
  }
};

const vizRecursions = {
  factorial: {
    label: "Factorial",
    complexity: "O(n) time, O(n) stack",
    note: "n! = n * (n-1)!. The call stack grows until it reaches the base case.",
    build(n) {
      const calls = [{ label: `fact(${n})`, depth: 0, state: "call" }];
      const fact = (k, depth) => {
        calls.push({ label: `fact(${k})`, depth, state: k <= 1 ? "base" : "wait" });
        if (k <= 1) {
          calls.push({ label: `fact(${k}) = 1`, depth, state: "return" });
          return 1;
        }
        const sub = fact(k - 1, depth + 1);
        const value = k * sub;
        calls.push({ label: `fact(${k}) = ${k} × ${sub} = ${value}`, depth, state: "return" });
        return value;
      };
      const result = fact(n, 0);
      return { frames: calls.map((c) => ({ title: c.state === "return" ? "Unwind" : "Call", note: c.label, nodes: null, calls: calls.map((x) => ({ ...x })) })), result, calls };
    }
  },

  fibonacci: {
    label: "Fibonacci",
    complexity: "O(2ⁿ) time — the reason to memoise",
    note: "Each call makes two calls. Watch how many times fib(1) is computed again and again.",
    build(n) {
      const calls = [];
      let recomputed = 0;
      const fib = (k, depth) => {
        calls.push({ label: `fib(${k})`, depth, state: "call" });
        if (k < 2) {
          calls.push({ label: `fib(${k}) = ${k}`, depth, state: "return" });
          return k;
        }
        if (k <= 5) recomputed += 1;
        const left = fib(k - 1, depth + 1);
        const right = fib(k - 2, depth + 1);
        const value = left + right;
        calls.push({ label: `fib(${k}) = ${left} + ${right} = ${value}`, depth, state: "return" });
        return value;
      };
      const result = fib(n, 0);
      const frames = calls.map((c) => ({ title: c.state === "return" ? "Unwind" : "Call", note: c.label, calls: calls.map((x) => ({ ...x })) }));
      return { frames, result, calls, recomputed };
    }
  },

  hanoi: {
    label: "Tower of Hanoi",
    complexity: "O(2ⁿ) moves — 2ⁿ − 1 of them",
    note: "Move n discs from one peg to another using a spare. The move count doubles with every disc.",
    build(n) {
      const calls = [];
      let moves = 0;
      const hanoi = (k, from, to, via, depth) => {
        calls.push({ label: `hanoi(${k}, ${from}->${to} via ${via})`, depth, state: "call" });
        if (k === 0) return;
        hanoi(k - 1, from, via, to, depth + 1);
        moves += 1;
        calls.push({ label: `move disc ${k}: ${from} -> ${to}   (move ${moves})`, depth, state: "move" });
        hanoi(k - 1, via, to, from, depth + 1);
        calls.push({ label: `hanoi(${k}, ${from}->${to}) done`, depth, state: "return" });
      };
      hanoi(n, "A", "C", "B", 0);
      const frames = calls.map((c) => ({ title: c.state === "move" ? "Move" : c.state === "return" ? "Unwind" : "Call", note: c.label, calls: calls.map((x) => ({ ...x })) }));
      return { frames, result: moves, calls, moves };
    }
  },

  gcd: {
    label: "GCD (Euclid)",
    complexity: "O(log min(a,b))",
    note: "gcd(a, b) = gcd(b, a mod b). The numbers shrink quickly until one is zero.",
    build(a, b) {
      const calls = [];
      let steps = 0;
      const gcd = (x, y, depth) => {
        calls.push({ label: `gcd(${x}, ${y})`, depth, state: "call" });
        steps += 1;
        if (y === 0) {
          calls.push({ label: `gcd(${x}, 0) = ${x}`, depth, state: "return" });
          return x;
        }
        calls.push({ label: `${x} mod ${y} = ${x % y}`, depth, state: "wait" });
        const value = gcd(y, x % y, depth + 1);
        calls.push({ label: `gcd(${x}, ${y}) = ${value}`, depth, state: "return" });
        return value;
      };
      const result = gcd(a, b, 0);
      const frames = calls.map((c) => ({ title: c.state === "return" ? "Unwind" : "Step", note: c.label, calls: calls.map((x) => ({ ...x })) }));
      return { frames, result, calls, steps };
    }
  }
};

const vizTrees = {
  bstInsert: {
    label: "BST insert",
    complexity: "O(h) — O(log n) balanced, O(n) worst",
    note: "Go left for smaller, right for larger, until you hit an empty spot.",
    run(values) {
      const frames = [];
      let nextId = 1;
      let root = null;
      for (const value of values) {
        frames.push({ title: `Insert ${value}`, note: "Start at the root and follow the comparisons.", nodes: root ? cloneTree(root) : null });
        if (!root) {
          root = { value, id: nextId++, left: null, right: null };
          frames.push({ title: `Insert ${value}`, note: "The tree was empty, so it becomes the root.", nodes: cloneTree(root) });
          continue;
        }
        let node = root;
        const path = [];
        while (true) {
          path.push(node.value);
          if (value < node.value) {
            if (!node.left) {
              node.left = { value, id: nextId++, left: null, right: null };
              frames.push({ title: `Insert ${value}`, note: `Went left from ${node.value} and found an empty spot.`, nodes: cloneTree(root), highlight: nextId - 1 });
              break;
            }
            node = node.left;
          } else {
            if (!node.right) {
              node.right = { value, id: nextId++, left: null, right: null };
              frames.push({ title: `Insert ${value}`, note: `Went right from ${node.value} and found an empty spot.`, nodes: cloneTree(root), highlight: nextId - 1 });
              break;
            }
            node = node.right;
          }
        }
        void path;
      }
      return { frames, result: root };
    }
  },

  traversals: {
    label: "Tree traversals",
    complexity: "O(n) each",
    note: "The same tree, visited four ways. The order is the only thing that changes.",
    run(values) {
      const build = () => {
        const root = { value: values[0], id: 1, left: null, right: null };
        const insert = (node, value, idRef) => {
          if (value < node.value) {
            if (!node.left) { node.left = { value, id: idRef.n++, left: null, right: null }; return; }
            insert(node.left, value, idRef);
          } else {
            if (!node.right) { node.right = { value, id: idRef.n++, left: null, right: null }; return; }
            insert(node.right, value, idRef);
          }
        };
        const idRef = { n: 2 };
        for (const value of values.slice(1)) insert(root, value, idRef);
        return root;
      };
      const root = build();
      const orders = [
        { label: "Pre-order (root, left, right)", visit: (n, out) => { out.push(n.value); if (n.left) orders[0].visit(n.left, out); if (n.right) orders[0].visit(n.right, out); } },
        { label: "In-order (left, root, right)", visit: (n, out) => { if (n.left) orders[1].visit(n.left, out); out.push(n.value); if (n.right) orders[1].visit(n.right, out); } },
        { label: "Post-order (left, right, root)", visit: (n, out) => { if (n.left) orders[2].visit(n.left, out); if (n.right) orders[2].visit(n.right, out); out.push(n.value); } }
      ];
      const frames = [{ title: "The tree", note: "Same shape for all three traversals.", nodes: cloneTree(root) }];
      for (const order of orders) {
        const out = [];
        order.visit(root, out);
        frames.push({ title: order.label, note: `Visits as ${out.join(", ")}.`, nodes: cloneTree(root), path: out });
      }
      return { frames, result: root };
    }
  }
};

const vizGraphs = {
  bfs: {
    label: "Breadth-first search",
    complexity: "O(V + E)",
    note: "Visit everything one step away, then two steps away. The queue is what makes it level by level.",
    run(edges) {
      const { nodes, neighbours } = buildGraph(edges);
      const frames = [];
      const seen = new Set();
      const queue = [];
      frames.push({ title: "Start at node 0", note: "Put the first node in the queue.", nodes, edges, queue: [...queue], visited: [] });
      queue.push(0);
      while (queue.length) {
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);
        frames.push({
          title: `Visit ${current}`,
          note: `Dequeued ${current}. Its neighbours join the queue.`,
          nodes,
          edges,
          visited: [...seen],
          queue: [...queue],
          current
        });
        for (const next of neighbours[current] || []) {
          if (!seen.has(next) && !queue.includes(next)) queue.push(next);
        }
        if (queue.length) {
          frames.push({ title: `Queue: ${queue.join(", ")}`, note: "Next in line.", nodes, edges, visited: [...seen], queue: [...queue] });
        }
      }
      frames.push({ title: "Done", note: `Visited ${seen.size} nodes in order.`, nodes, edges, visited: [...seen], queue: [] });
      return { frames, result: [...seen] };
    }
  },

  dfs: {
    label: "Depth-first search",
    complexity: "O(V + E)",
    note: "Follow one path as far as it goes, then back up. A stack makes this iterative.",
    run(edges) {
      const { nodes, neighbours } = buildGraph(edges);
      const frames = [];
      const seen = new Set();
      const stack = [0];
      frames.push({ title: "Start at node 0", note: "Push the first node.", nodes, edges, stack: [...stack], visited: [] });
      while (stack.length) {
        const current = stack.pop();
        if (seen.has(current)) continue;
        seen.add(current);
        frames.push({
          title: `Visit ${current}`,
          note: `Popped ${current}. Push its unvisited neighbours.`,
          nodes,
          edges,
          visited: [...seen],
          stack: [...stack],
          current
        });
        const next = (neighbours[current] || []).filter((n) => !seen.has(n));
        for (const n of next.reverse()) if (!stack.includes(n)) stack.push(n);
      }
      frames.push({ title: "Done", note: `Visited ${seen.size} nodes in order.`, nodes, edges, visited: [...seen], stack: [] });
      return { frames, result: [...seen] };
    }
  },

  dijkstra: {
    label: "Dijkstra's algorithm",
    complexity: "O((V + E) log V)",
    note: "Always expand the cheapest known route. Weights are the edge labels.",
    run(edges) {
      const { nodes, adj } = buildGraph(edges);
      const dist = {};
      for (const node of nodes) dist[node] = Infinity;
      dist[0] = 0;
      const seen = new Set();
      const frames = [{ title: "Start", note: "Distance to node 0 is 0, everything else is unknown.", nodes, edges, dist: { ...dist }, visited: [] }];
      while (true) {
        let current = null;
        let best = Infinity;
        for (const node of nodes) {
          if (!seen.has(node) && dist[node] < best) {
            best = dist[node];
            current = node;
          }
        }
        if (current === null) break;
        seen.add(current);
        frames.push({ title: `Settle ${current} at ${best}`, note: `This is the cheapest way to reach ${current}.`, nodes, edges, dist: { ...dist }, visited: [...seen], current });
        for (const edge of adj[current] || []) {
          const [to, weight] = edge;
          if (dist[current] + weight < dist[to]) {
            dist[to] = dist[current] + weight;
            frames.push({ title: `Relax edge to ${to}`, note: `Route to ${to} improves to ${dist[to]}.`, nodes, edges, dist: { ...dist }, visited: [...seen], current });
          }
        }
      }
      frames.push({ title: "Done", note: "Every shortest distance is settled.", nodes, edges, dist: { ...dist }, visited: [...seen] });
      return { frames, result: dist };
    }
  }
};

const vizPatterns = {
  slidingWindow: {
    label: "Sliding window",
    complexity: "O(n)",
    note: "Slide a window of fixed size across the array, updating the answer instead of recomputing it.",
    run(input, k) {
      const frames = [];
      let sum = 0;
      for (let i = 0; i < input.length; i += 1) {
        sum += input[i];
        frames.push({ title: `Extend to ${i}`, note: `Added ${input[i]}. Window sum is ${sum}.`, array: input.slice(), range: [Math.max(0, i - k + 1), i], pointers: [i] });
        if (i >= k) {
          sum -= input[i - k];
          frames.push({ title: `Drop ${input[i - k]}`, note: `The window is now ${k} long. Sum is ${sum}.`, array: input.slice(), range: [i - k + 1, i], pointers: [i - k, i] });
        }
        if (i >= k - 1) frames.push({ title: "Full window", note: `Window [${i - k + 1}..${i}] sums to ${sum}.`, array: input.slice(), range: [i - k + 1, i] });
      }
      return { frames, result: sum };
    }
  },
  twoPointers: {
    label: "Two pointers",
    complexity: "O(n)",
    note: "One pointer at each end. Each step eliminates a value, so the search shrinks.",
    run(input, target) {
      const frames = [];
      let lo = 0;
      let hi = input.length - 1;
      while (lo <= hi) {
        const sum = input[lo] + input[hi];
        frames.push({
          title: `Check ${input[lo]} + ${input[hi]}`,
          note: sum === target
            ? `Found ${target}.`
            : sum < target
              ? `Too small, move the left pointer right.`
              : `Too big, move the right pointer left.`,
          array: input.slice(),
          pointers: [lo, hi]
        });
        if (sum === target) return { frames, result: { lo, hi } };
        if (sum < target) lo += 1;
        else hi -= 1;
      }
      frames.push({ title: "No pair", note: `${target} cannot be made from this array.`, array: input.slice() });
      return { frames, result: null };
    }
  },
  prefixSum: {
    label: "Prefix sum",
    complexity: "O(n) build, O(1) per query",
    note: "Precompute running totals so any range sum is one subtraction.",
    run(input) {
      const frames = [];
      const prefix = [0];
      for (let i = 0; i < input.length; i += 1) {
        prefix.push(prefix[i] + input[i]);
        frames.push({ title: `Add ${input[i]}`, note: `Running total is ${prefix[i + 1]}.`, array: input.slice(), pointers: [i], range: [0, i] });
      }
      frames.push({ title: "Any range is one subtraction", note: `Sum of [1..3] = ${prefix[4]} − ${prefix[1]} = ${prefix[4] - prefix[1]}.`, array: input.slice(), range: [1, 3] });
      return { frames, result: prefix };
    }
  },
  kadane: {
    label: "Kadane's algorithm",
    complexity: "O(n)",
    note: "Track the best subarray ending here. If the running sum goes negative, restart it.",
    run(input) {
      const frames = [];
      let best = input[0];
      let current = input[0];
      let startIndex = 0;
      let bestStart = 0;
      let bestEnd = 0;
      frames.push({ title: "Start", note: `Begin with ${input[0]}.`, array: input.slice(), pointers: [0] });
      for (let i = 1; i < input.length; i += 1) {
        if (current + input[i] < input[i]) {
          current = input[i];
          startIndex = i;
          frames.push({ title: `Restart at ${i}`, note: `Keeping ${input[i - 1]} would drag the sum negative, so start fresh.`, array: input.slice(), pointers: [i], range: [i, i] });
        } else {
          current += input[i];
          frames.push({ title: `Extend to ${i}`, note: `Best subarray ending here sums to ${current}.`, array: input.slice(), pointers: [i], range: [startIndex, i] });
        }
        if (current > best) {
          best = current;
          bestStart = startIndex;
          bestEnd = i;
        }
      }
      frames.push({ title: `Best is ${best}`, note: `That is the subarray from index ${bestStart} to ${bestEnd}.`, array: input.slice(), range: [bestStart, bestEnd] });
      return { frames, result: best };
    }
  }
};

const vizDp = {
  fibonacci: {
    label: "Fibonacci (DP)",
    complexity: "O(n) — each value is computed once",
    note: "The same Fibonacci as the recursive version, but each answer is remembered.",
    run(n) {
      const frames = [];
      const dp = [0, 1];
      frames.push({ title: "Base cases", note: "fib(0) = 0 and fib(1) = 1.", table: [{ index: 0, value: 0 }, { index: 1, value: 1 }], highlight: null });
      for (let i = 2; i <= n; i += 1) {
        dp[i] = dp[i - 1] + dp[i - 2];
        frames.push({
          title: `fib(${i}) = fib(${i - 1}) + fib(${i - 2})`,
          note: `That is ${dp[i - 1]} + ${dp[i - 2]} = ${dp[i]}.`,
          table: dp.map((value, index) => ({ index, value })),
          highlight: i
        });
      }
      return { frames, result: dp[n] };
    }
  },
  climbStairs: {
    label: "Climbing stairs",
    complexity: "O(n)",
    note: "To reach step n you came from n-1 or n-2. That is Fibonacci wearing a different hat.",
    run(n) {
      const frames = [];
      const dp = [1, 1];
      frames.push({ title: "Base cases", note: "There is one way to be on step 0 and one way to be on step 1.", table: [{ index: 0, value: 1 }, { index: 1, value: 1 }], highlight: null });
      for (let i = 2; i <= n; i += 1) {
        dp[i] = dp[i - 1] + dp[i - 2];
        frames.push({ title: `ways(${i}) = ${dp[i - 1]} + ${dp[i - 2]}`, note: `From step ${i - 1} or step ${i - 2}.`, table: dp.map((value, index) => ({ index, value })), highlight: i });
      }
      return { frames, result: dp[n] };
    }
  },
  knapsack: {
    label: "0/1 knapsack",
    complexity: "O(items × capacity)",
    note: "Each item is used at most once, so the table has to be filled in a fixed order.",
    run(weights, values, capacity) {
      const frames = [];
      const rows = weights.length;
      const cols = capacity + 1;
      const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
      frames.push({
        title: "Empty table",
        note: `Best value for each capacity, for each item so far.`,
        table2d: table,
        weights,
        capacity,
        highlight: null
      });
      for (let i = 0; i < rows; i += 1) {
        for (let c = 0; c < cols; c += 1) {
          if (weights[i] > c) {
            table[i][c] = i === 0 ? 0 : table[i - 1][c];
          } else {
            const take = values[i] + (i === 0 ? 0 : table[i - 1][c - weights[i]]);
            const skip = i === 0 ? 0 : table[i - 1][c];
            table[i][c] = Math.max(take, skip);
          }
          frames.push({
            title: `Item ${i + 1}, capacity ${c}`,
            note: `Best is ${table[i][c]}.`,
            table2d: table.map((row) => row.slice()),
            weights,
            capacity,
            highlight: { row: i, col: c }
          });
        }
      }
      return { frames, result: table[rows - 1][capacity] };
    }
  },
  lcs: {
    label: "Longest common subsequence",
    complexity: "O(n·m)",
    note: "Compare the two strings cell by cell. Matching characters extend the diagonal.",
    run(a, b) {
      const frames = [];
      const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      frames.push({ title: "Empty table", note: "Zero for every prefix pair.", table2d: table, headers: [..." "].concat([...b]), rowLabels: [..." "].concat([...a]), highlight: null });
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          if (a[i - 1] === b[j - 1]) table[i][j] = table[i - 1][j - 1] + 1;
          else table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
          frames.push({
            title: `'${a[i - 1]}' vs '${b[j - 1]}'`,
            note: a[i - 1] === b[j - 1] ? `They match, so extend to ${table[i][j]}.` : `No match, take the better of above and left: ${table[i][j]}.`,
            table2d: table.map((row) => row.slice()),
            headers: [..." "].concat([...b]),
            rowLabels: [..." "].concat([...a]),
            highlight: { row: i, col: j }
          });
        }
      }
      return { frames, result: table[a.length][b.length] };
    }
  }
};

/* ------------------------- shared helpers ------------------------------ */

const cloneTree = (node) => {
  if (!node) return null;
  return { value: node.value, id: node.id, left: cloneTree(node.left), right: cloneTree(node.right) };
};

/* Builds an undirected adjacency map from [from, to, weight] triples.

   Both views are kept, and they are different on purpose:
     - `adj[node]` is a list of `[neighbour, weight]` pairs, which is what the
       weighted algorithms (Dijkstra) need;
     - `neighbours[node]` is a flat list of node ids, which is what BFS and DFS
       need.

   An earlier version had BFS and DFS read the weighted pairs as if they were
   node ids, which made them visit the same node twice and count the wrong
   number of nodes. Keeping both shapes means neither has to unpack the other's
   data. */
const buildGraph = (edges) => {
  const nodes = [];
  const adj = {};
  const neighbours = {};
  const addNode = (node) => {
    if (!nodes.includes(node)) nodes.push(node);
    if (!adj[node]) adj[node] = [];
    if (!neighbours[node]) neighbours[node] = [];
  };

  for (const [from, to, weight] of edges) {
    addNode(from);
    addNode(to);
    const w = weight === undefined ? 1 : weight;
    adj[from].push([to, w]);
    adj[to].push([from, w]);
    if (!neighbours[from].includes(to)) neighbours[from].push(to);
    if (!neighbours[to].includes(from)) neighbours[to].push(from);
  }

  nodes.sort((a, b) => a - b);
  return { nodes, adj, neighbours };
};

/* Flattens a BST into positioned nodes so the renderer never has to do layout.
   x comes from an in-order index (so bigger values sit further right) and depth
   from the level, which is exactly how a BST is drawn on a whiteboard. */
const layoutTree = (root) => {
  const placed = [];
  let index = 0;
  const walk = (node, depth) => {
    if (!node) return;
    walk(node.left, depth + 1);
    placed.push({ id: node.id, value: node.value, depth, order: index });
    index += 1;
    walk(node.right, depth + 1);
  };
  walk(root, 0);
  if (!placed.length) return { nodes: [], edges: [], width: 0 };
  const span = Math.max(1, placed.length - 1);
  for (const node of placed) node.x = node.order / span;
  const ids = new Map(placed.map((n) => [n.id, n]));
  const edges = [];
  const connect = (node) => {
    if (!node) return;
    for (const child of [node.left, node.right]) {
      if (child && ids.has(child.id)) edges.push([node.id, child.id]);
      connect(child);
    }
  };
  connect(root);
  return { nodes: placed, edges, width: span };
};

/* Every visualizer, in one registry, so the UI can be built from the data
   instead of a hand-maintained list that would drift out of date. */
const VISUALIZERS = {
  sort: {
    label: "Sorting",
    note: "Watch each algorithm rearrange the same array.",
    items: vizSorters
  },
  search: {
    label: "Searching",
    note: "Find a value in an array, and see why the number of steps differs.",
    items: vizSearchers
  },
  recursion: {
    label: "Recursion",
    note: "Follow the call stack as it grows and unwinds.",
    items: vizRecursions
  },
  tree: {
    label: "Trees",
    note: "Insert into a binary search tree and walk it.",
    items: vizTrees
  },
  graph: {
    label: "Graphs",
    note: "Search and shortest paths over a small graph.",
    items: vizGraphs
  },
  pattern: {
    label: "Patterns",
    note: "The array patterns that come up in almost every interview.",
    items: vizPatterns
  },
  dp: {
    label: "Dynamic programming",
    note: "Fill the table one cell at a time.",
    items: vizDp
  }
};

/* Default inputs, chosen small enough to read on a phone. Every one of them is
   a fixed example rather than random, so a lesson looks the same every time it
   is opened - which is what makes it possible to describe a specific step. */
const VIZ_EXAMPLES = {
  sort: {
    array: [5, 2, 9, 1, 5, 6, 3],
    searchArray: [1, 3, 5, 7, 9, 11, 13, 15],
    searchTarget: 11
  },
  search: {
    array: [1, 3, 5, 7, 9, 11, 13, 15],
    target: 11
  },
  recursion: {
    factorial: 5,
    fibonacci: 8,
    hanoi: 3,
    gcdA: 48,
    gcdB: 18
  },
  tree: {
    values: [50, 30, 70, 20, 40, 60, 80]
  },
  graph: {
    edges: [[0, 1, 4], [0, 2, 1], [2, 1, 2], [1, 3, 1], [2, 3, 5], [3, 4, 3]]
  },
  pattern: {
    array: [2, 1, 5, 1, 3, 2, 8, 1],
    k: 3,
    target: 9,
    sorted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  },
  dp: {
    n: 8,
    items: [
      { weight: 2, value: 6 },
      { weight: 3, value: 10 },
      { weight: 4, value: 12 },
      { weight: 5, value: 20 }
    ],
    capacity: 8,
    strA: "ABCBDAB",
    strB: "BDCABA"
  }
};

/* Exposed for both environments. In Node this is what
   scripts/test-visualizer.js requires; in the browser it is what the player
   in lab-notes.js reads. Attaching to `window` as well as exporting is not
   duplication - a script tag has no module object, so without the window
   assignment the whole library would be invisible to the page. */
const VISUALIZER_API = {
  VISUALIZERS,
  VIZ_EXAMPLES,
  vizSorters,
  vizSearchers,
  vizRecursions,
  vizTrees,
  vizGraphs,
  vizPatterns,
  vizDp,
  layoutTree,
  buildGraph,
  cloneTree
};

if (typeof window !== "undefined" && window) {
  window.VISUALIZERS = VISUALIZERS;
  window.VIZ_EXAMPLES = VIZ_EXAMPLES;
  /* The layout helper is called directly by the player, so it has to be a
     global in its own right and not only reachable through the bundle. */
  window.layoutTree = layoutTree;
  window.buildGraph = buildGraph;
  window.visualizerEngine = VISUALIZER_API;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = VISUALIZER_API;
}
