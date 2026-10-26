@IsTest
private class DemoMathTest {
    @IsTest
    static void addsTwoNumbers() {
        System.assertEquals(4, DemoMath.add(2, 2), 'expected 2 + 2 to be 4');
    }
}
