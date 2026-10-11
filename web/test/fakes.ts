// What the fakes of the tests share.

export function unfakedBy(owner: string) {
  return (name: string) => (): never => {
    throw new Error(`${owner}.${name} is not faked`);
  };
}
