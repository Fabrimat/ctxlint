# Clean fixture

The library entry point is `src/index.ts`; see also [the answer](src/answer.ts).

```sh
npm run build
npm test
```

Use `describeAnswer()` to print it, built with `typescript@5`:

```ts
import { describeAnswer } from './src/answer.ts';

console.log(describeAnswer('The answer is'));
```
